-- SPDX-FileCopyrightText: 2026 Manuel Weißböck
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Pure helpers for the control skin. No dependency on mpv ("mp"), so they run under plain lua5.4 in the tests.
local M = {}

M.HIDE_AFTER_S = 3

local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

-- Lua 5.1/LuaJIT compatible (mpv builds embed LuaJIT): no //, no bitwise operators, no goto

--- integer division (replaces the // operator)
function M.idiv(a, b) return math.floor(a / b) end

--- finite number or 0 (state from the app is not trusted)
function M.num(v)
  v = tonumber(v)
  if not v or v ~= v or v == math.huge or v == -math.huge then return 0 end
  return v
end

--- only the table entries of an array
function M.list(v)
  local r = {}
  if type(v) ~= 'table' then return r end
  for _, e in ipairs(v) do
    if type(e) == 'table' then r[#r + 1] = e end
  end
  return r
end

local CHAR = '[%z\1-\127\194-\244][\128-\191]*'

--- number of UTF-8 characters
function M.utf8_len(s)
  local n = 0
  for _ in tostring(s or ''):gmatch(CHAR) do n = n + 1 end
  return n
end

--- at most n characters, cut on a character boundary, with an ellipsis
function M.clip(s, n)
  s = tostring(s or '')
  if M.utf8_len(s) <= n then return s end
  local out, i = {}, 0
  for ch in s:gmatch(CHAR) do
    i = i + 1
    if i >= n then break end
    out[#out + 1] = ch
  end
  return table.concat(out) .. '…'
end

--- text for an ASS event: no override blocks, no backslash escapes (U+2060 after each backslash, as mpv does)
function M.esc(s)
  s = tostring(s or ''):gsub('\\', '\\\226\129\160'):gsub('{', '('):gsub('}', ')'):gsub('\r?\n', ' ')
  return s
end

--- seconds as "1:02:03" (with hours) or "2:03"; negative and unknown values become "0:00"
function M.fmt_time(s)
  s = math.floor(tonumber(s) or 0)
  if s < 0 then s = 0 end
  local h = M.idiv(s, 3600)
  local m = M.idiv(s % 3600, 60)
  local sec = s % 60
  if h > 0 then return string.format('%d:%02d:%02d', h, m, sec) end
  return string.format('%d:%02d', m, sec)
end

--- time under an x position on the seek bar, clamped to 0..duration (0 for an unusable bar or duration)
function M.seek_to_time(x, bar_x, bar_w, duration)
  duration = tonumber(duration) or 0
  if not bar_w or bar_w <= 0 or duration <= 0 then return 0 end
  return clamp((x - bar_x) / bar_w, 0, 1) * duration
end

--- x positions of the chapter marks; chapters at or before the start and beyond the end get no mark
function M.chapter_marks(chapters, bar_x, bar_w, duration)
  local marks = {}
  duration = tonumber(duration) or 0
  if not chapters or duration <= 0 then return marks end
  for _, c in ipairs(chapters) do
    local t = tonumber(c.t)
    if t and t > 0 and t < duration then marks[#marks + 1] = bar_x + (t / duration) * bar_w end
  end
  return marks
end

--- true when the controls hide: 3 s without mouse movement while playing; paused keeps them shown
function M.should_hide(now, last_move, paused)
  if paused then return false end
  return (now - last_move) >= M.HIDE_AFTER_S
end

return M
