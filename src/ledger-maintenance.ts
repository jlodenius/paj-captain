import * as fs from "node:fs";
import { opendir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { MAX_BYTES, securePath, validate } from "./tasks.ts";
import { errorCode } from "./types.ts";

const ledgerName = /^[a-zA-Z0-9_-]{1,160}\.json$/;
// Preserve the published on-disk interruption sentinel even though the attestation is gone.
const interruptionMarker = "captain-ledger-cutover-v1\n";
const scanLimit = 16384;
const scanBytes = 32 * 1024 ** 3;
const scanMs = 60000;
export const WARNING_BYTES = 3 * 1024 ** 3;
export const ERASE_PHRASE = "ERASE ALL CAPTAIN LEDGERS";

function safeFile(fd: number, file: string) {
  const stat = fs.fstatSync(fd);
  const current = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid!() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077 ||
    stat.ino !== current.ino ||
    stat.dev !== current.dev
  )
    throw new Error("Unsafe Captain ledger file");
  return stat;
}

function lock(file: string, exclusive: boolean, create: boolean, busy: string) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDWR |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK |
      (create ? fs.constants.O_CREAT : 0),
    0o600,
  );
  try {
    safeFile(fd, file);
    const acquired = spawnSync("flock", ["-n", exclusive ? "-x" : "-s", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout: 5000,
    });
    if (
      acquired.error ||
      acquired.signal ||
      (acquired.status !== 0 && acquired.status !== 1)
    ) {
      throw new Error(
        "Cannot verify Captain ledger lock; no operation performed",
      );
    }
    if (acquired.status === 1) throw new Error(busy);
    safeFile(fd, file);
    return () => fs.closeSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function createLedgerMaintenance(dir: string) {
  const gate = ".captain-ledger-gate";
  const interruption = ".captain-ledger-erase-incomplete";
  const epoch = ".captain-ledger-epoch";
  const busy =
    "Captain is enabled or finishing an operation in a local Pi session. Turn Captain off in all sessions and retry when idle.";
  function openDirectory(create: boolean) {
    securePath(join(dir, gate), create);
    const fd = fs.openSync(
      dir,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(fd);
    if (stat.uid !== process.getuid!() || stat.mode & 0o077) {
      fs.closeSync(fd);
      throw new Error("Unsafe Captain ledger directory");
    }
    return fd;
  }
  // Linux has no Node unlinkat; use the pinned directory descriptor for every destructive path.
  const anchored = (fd: number) => `/proc/self/fd/${fd}`;
  function eraseInterrupted(base: string) {
    const file = join(base, interruption);
    let fd;
    try {
      fd = fs.openSync(
        file,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    try {
      if (
        safeFile(fd, file).size !== interruptionMarker.length ||
        fs.readFileSync(fd, "utf8") !== interruptionMarker
      ) {
        throw new Error(
          "Unrecognized Captain ledger erasure interruption marker; inspect it offline",
        );
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }
  function readEpoch(base: string) {
    const path = join(base, epoch);
    let fd;
    try {
      fd = fs.openSync(
        path,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "initial";
      throw error;
    }
    try {
      if (safeFile(fd, path).size !== 36)
        throw new Error("Invalid Captain ledger epoch");
      const value = fs.readFileSync(fd, "utf8");
      if (!/^[0-9a-f-]{36}$/.test(value))
        throw new Error("Invalid Captain ledger epoch");
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }
  function publishMarker(dirFd: number, name: string, content: string) {
    const base = anchored(dirFd);
    const temporary = join(base, `.captain-marker-${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
      fs.renameSync(temporary, join(base, name));
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
  function scan(base: string) {
    const deadline = performance.now() + scanMs;
    const checkTime = () => {
      if (performance.now() > deadline)
        throw new Error(
          "Ledger preview exceeded its time budget; no erase attempted",
        );
    };
    const names: string[] = [];
    const legacyLocks = new Set<string>();
    const directory = fs.opendirSync(base);
    try {
      let count = 0;
      for (let entry; (entry = directory.readSync());) {
        checkTime();
        if (++count > scanLimit)
          throw new Error(
            "Too many directory entries to safely preview ledger erasure",
          );
        if (ledgerName.test(entry.name)) names.push(entry.name);
        if (/^[a-zA-Z0-9_-]{1,160}\.json\.lock$/.test(entry.name)) {
          lock(
            join(base, entry.name),
            true,
            false,
            "A ledger writer may be from an older runtime. Quit all older Pi/SDK processes and retry",
          )();
          legacyLocks.add(entry.name);
        }
        if (
          /^[a-zA-Z0-9_-]{1,160}\.json\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)
        ) {
          throw new Error(
            "Unresolved ledger write temporary file; inspect it offline before retrying",
          );
        }
      }
    } finally {
      directory.closeSync();
    }
    const directoryStat = fs.statSync(base);
    const digest = createHash("sha256").update(
      `${directoryStat.dev}:${directoryStat.ino}\n`,
    );
    const files = new Map<string, fs.Stats>();
    let tasks = 0;
    let unresolved = 0;
    let totalBytes = 0;
    for (const name of names.sort()) {
      checkTime();
      const file = join(base, name);
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      try {
        const stat = safeFile(fd, file);
        if (stat.size > MAX_BYTES)
          throw new Error("Oversized Captain ledger; cannot safely preview");
        totalBytes += stat.size;
        if (totalBytes > scanBytes)
          throw new Error(
            "Ledger preview exceeded its byte budget; no erase attempted",
          );
        const bytes = Buffer.allocUnsafe(stat.size + 1);
        let offset = 0;
        for (
          let n;
          offset < bytes.length &&
          (n = fs.readSync(fd, bytes, offset, bytes.length - offset, null));
        )
          offset += n;
        if (
          offset !== stat.size ||
          safeFile(fd, file).mtimeMs !== stat.mtimeMs
        ) {
          throw new Error(
            "Ledger changed while reading; quit any older runtimes and retry",
          );
        }
        const state = validate(JSON.parse(bytes.toString("utf8", 0, offset)));
        if (
          Object.keys(state).some(
            (key) => !["version", "tasks", "pajCheckpoints"].includes(key),
          ) ||
          state.tasks.some(
            (task) => `${task.ownerPiSessionId}.json` !== name,
          ) ||
          (!state.tasks.length && !legacyLocks.has(`${name}.lock`))
        ) {
          throw new Error(
            "Cannot verify this file is a Captain ledger for the named session",
          );
        }
        digest
          .update(`${name}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${offset}:`)
          .update(bytes.subarray(0, offset));
        files.set(name, stat);
        tasks += state.tasks.length;
        unresolved += state.tasks.filter(
          (task) =>
            task.status !== "completed" ||
            !task.requestMessageId ||
            task.questionsTruncated ||
            task.replies.some((reply) => reply.status !== "queued") ||
            task.questions.some(
              (question) =>
                !question.supersededBy &&
                !task.replies.some(
                  (reply) =>
                    reply.questionId === question.id &&
                    reply.status === "queued",
                ),
            ),
        ).length;
      } finally {
        fs.closeSync(fd);
      }
    }
    return { names, digest: digest.digest("hex"), tasks, unresolved, files };
  }
  function exclusive<T>(create: boolean, fn: (fd: number, base: string) => T) {
    const fd = openDirectory(create);
    try {
      const base = anchored(fd);
      const release = lock(join(base, gate), true, create, busy);
      try {
        return fn(fd, base);
      } finally {
        release();
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    lease(expectedEpoch?: string) {
      const fd = openDirectory(true);
      try {
        const base = anchored(fd);
        const release = lock(
          join(base, gate),
          false,
          true,
          "Captain ledger maintenance is running; retry when it finishes",
        );
        try {
          if (eraseInterrupted(base))
            throw new Error(
              "Captain ledger erasure was interrupted; rerun /captain erase-ledgers while off to review and finish",
            );
          const value = readEpoch(base);
          if (expectedEpoch !== undefined && expectedEpoch !== value) {
            throw new Error(
              "Captain ledgers were erased during navigation; run /captain explicitly to start again",
            );
          }
          return Object.assign(release, { epoch: value });
        } catch (error) {
          release();
          throw error;
        }
      } finally {
        fs.closeSync(fd);
      }
    },
    preview() {
      return exclusive(true, (_fd, base) => {
        const interrupted = eraseInterrupted(base);
        const { names, digest, tasks, unresolved } = scan(base);
        return {
          names,
          digest: `${interrupted}:${digest}`,
          tasks,
          unresolved,
          interrupted,
        };
      });
    },
    erase(expected: string) {
      return exclusive(false, (fd, base) => {
        const interrupted = eraseInterrupted(base);
        const snapshot = scan(base);
        if (`${interrupted}:${snapshot.digest}` !== expected) {
          throw new Error(
            "Saved ledgers changed after preview; rerun and confirm again",
          );
        }
        const verifyFile = (name: string, expected: fs.Stats) => {
          const path = join(base, name);
          const current = fs.lstatSync(path);
          if (
            !current.isFile() ||
            current.ino !== expected.ino ||
            current.dev !== expected.dev ||
            current.ctimeMs !== expected.ctimeMs ||
            current.mtimeMs !== expected.mtimeMs ||
            current.size !== expected.size
          )
            throw new Error("Ledger changed during erasure");
          return path;
        };
        for (const [name, expected] of snapshot.files)
          verifyFile(name, expected);
        if (!interrupted) publishMarker(fd, interruption, interruptionMarker);
        let erased = 0;
        try {
          publishMarker(fd, epoch, randomUUID());
          for (const [name, expected] of snapshot.files) {
            fs.unlinkSync(verifyFile(name, expected));
            erased++;
          }
          fs.fsyncSync(fd);
          fs.unlinkSync(join(base, interruption));
          fs.fsyncSync(fd);
        } catch (error) {
          throw new Error(
            `Erase interrupted after ${erased}/${snapshot.names.length} removals; durability may be uncertain. Inspect remaining ledgers and rerun with fresh confirmation.`,
            { cause: error },
          );
        }
        return erased;
      });
    },
    async large() {
      const deadline = performance.now() + 350;
      try {
        securePath(join(dir, gate), false);
        const directory = await opendir(dir);
        let bytes = 0;
        let count = 0;
        for await (const entry of directory) {
          if (++count > 2048 || performance.now() > deadline) return false;
          if (!ledgerName.test(entry.name) || !entry.isFile()) continue;
          const stat = await lstat(join(dir, entry.name));
          if (
            stat.isFile() &&
            stat.uid === process.getuid!() &&
            stat.nlink === 1 &&
            !(stat.mode & 0o077)
          ) {
            bytes += stat.size;
            if (bytes > WARNING_BYTES) return true;
          }
        }
      } catch {
        /* A partial scan cannot establish that the ledgers are small. */
      }
      return false;
    },
  };
}
