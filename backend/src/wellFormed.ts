// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/** String.prototype.isWellFormed (ES2024): false for a lone surrogate, which the database and the audit log cannot store */
export const wellFormed = (s: string): boolean => (s as string & { isWellFormed(): boolean }).isWellFormed();
