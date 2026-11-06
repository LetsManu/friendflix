// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/tv';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  rail: { label: 'Main menu', profile: 'Switch profile, {name}' },
  tile: { top10: 'Top 10 · #{n}' },
};
export default dict;
