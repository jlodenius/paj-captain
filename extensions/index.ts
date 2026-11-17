import { compact, VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { registerCaptain } from '../src/extension.ts';

export default function (pi: ExtensionAPI) {
  registerCaptain(pi, Type, { compact, piVersion: VERSION });
}
