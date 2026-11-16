// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GroupCheck } from '../engine.js';
import { coreCheck } from './core.js';
import { livetvCheck } from './livetv.js';
import { mailCheck } from './mail.js';
import { mediaCheck } from './media.js';
import { signinCheck } from './signin.js';
import { updatesCheck } from './updates.js';

/** The built-in group checks, registered by the engine at module load (later stages add theirs here). */
export const BUILTIN_CHECKS: readonly GroupCheck[] = [coreCheck, mailCheck, signinCheck, mediaCheck, livetvCheck, updatesCheck];
