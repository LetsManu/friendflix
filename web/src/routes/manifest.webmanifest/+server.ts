// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RequestHandler } from './$types';
import { cachedManifestBrand, chooseLang, manifestFor } from '#lib/manifest';

export const prerender = false;

export const GET: RequestHandler = async ({ url, request }) => {
  const lang = chooseLang(url.searchParams.get('lang'), request.headers.get('accept-language'));
  // the brand from the backend's public route (BACKEND_URL, the internal address as compose sets it, like web/server reads its env
  // from process.env; unset or unreachable: the defaults), remembered for a minute
  const brand = await cachedManifestBrand(process.env.BACKEND_URL);
  return new Response(JSON.stringify(await manifestFor(lang, brand)), {
    headers: {
      'content-type': 'application/manifest+json',
      // short cache: a language or brand change is picked up quickly; the answer also depends on Accept-Language when ?lang is missing
      'cache-control': 'public, max-age=300',
      vary: 'Accept-Language',
    },
  });
};
