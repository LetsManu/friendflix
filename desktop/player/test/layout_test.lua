-- SPDX-FileCopyrightText: 2026 Manuel Weißböck
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Tests for the pure helpers in layout.lua; run with: lua5.4 desktop/player/test/layout_test.lua
local here = (arg and arg[0] or ''):match('^(.*)[/\\]test[/\\][^/\\]*$') or '.'
package.path = here .. '/?.lua;' .. package.path
local L = require('layout')

local function test_fmt_time()
  assert(L.fmt_time(0) == '0:00')
  assert(L.fmt_time(5) == '0:05')
  assert(L.fmt_time(123) == '2:03')
  assert(L.fmt_time(599.9) == '9:59')
  assert(L.fmt_time(3600) == '1:00:00')
  assert(L.fmt_time(3723) == '1:02:03')
  assert(L.fmt_time(36000 + 61) == '10:01:01')
  assert(L.fmt_time(-4) == '0:00')
  assert(L.fmt_time(nil) == '0:00')
end

local function test_seek_to_time()
  assert(L.seek_to_time(100, 100, 400, 1000) == 0)
  assert(L.seek_to_time(300, 100, 400, 1000) == 500)
  assert(L.seek_to_time(500, 100, 400, 1000) == 1000)
  assert(L.seek_to_time(0, 100, 400, 1000) == 0, 'left of the bar clamps to 0')
  assert(L.seek_to_time(9999, 100, 400, 1000) == 1000, 'right of the bar clamps to duration')
  assert(L.seek_to_time(200, 100, 0, 1000) == 0, 'zero width')
  assert(L.seek_to_time(200, 100, 400, 0) == 0, 'zero duration')
  assert(L.seek_to_time(200, 100, 400, nil) == 0, 'unknown duration')
end

local function test_chapter_marks()
  local ch = { { t = 0, name = 'a' }, { t = 250, name = 'b' }, { t = 500, name = 'c' }, { t = 2000, name = 'late' }, { t = -5, name = 'neg' } }
  local m = L.chapter_marks(ch, 100, 400, 1000)
  assert(#m == 2, 'start (t=0), out-of-range and negative chapters are skipped, got ' .. #m)
  assert(m[1] == 200 and m[2] == 300)
  assert(#L.chapter_marks({}, 0, 100, 10) == 0)
  assert(#L.chapter_marks(nil, 0, 100, 10) == 0)
  assert(#L.chapter_marks(ch, 0, 100, 0) == 0, 'no duration, no marks')
end

local function test_should_hide()
  assert(L.should_hide(10, 8, false) == false, '2 s after movement')
  assert(L.should_hide(10.99, 8, false) == false, 'just under 3 s')
  assert(L.should_hide(11, 8, false) == true, 'exactly 3 s')
  assert(L.should_hide(20, 8, false) == true)
  assert(L.should_hide(20, 8, true) == false, 'paused stays shown')
end

test_fmt_time()
test_seek_to_time()
test_chapter_marks()
test_should_hide()
print('layout_test: ok')
