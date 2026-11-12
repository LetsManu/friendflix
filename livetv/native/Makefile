# SPDX-FileCopyrightText: 2026 Manuel Weißböck
# SPDX-License-Identifier: AGPL-3.0-or-later
# srtgate (plan ruling 2): links the system libsrt (Debian: libsrt-openssl-dev to build, libsrt1.5-openssl to run).
CC ?= gcc
CFLAGS ?= -O2 -std=c11 -Wall -Wextra -Wpedantic -D_GNU_SOURCE -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE
LDFLAGS ?= -pie -Wl,-z,relro,-z,now
SRT_CFLAGS := $(shell pkg-config --cflags srt 2>/dev/null)
SRT_LIBS := $(shell pkg-config --libs srt 2>/dev/null || echo -lsrt)
LDLIBS = $(SRT_LIBS) -lpthread

all: srtgate

srtgate: srtgate.c
	$(CC) $(CFLAGS) $(SRT_CFLAGS) -o $@ $< $(LDFLAGS) $(LDLIBS)

syntax:
	$(CC) $(CFLAGS) $(SRT_CFLAGS) -fsyntax-only srtgate.c

selftest: srtgate
	./srtgate --selftest

clean:
	rm -f srtgate

.PHONY: all syntax selftest clean
