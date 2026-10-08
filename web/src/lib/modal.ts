import { pushState } from '$app/navigation';

/** Opens the detail popup over the current page (shallow routing: URL changes, page does not reload). */
export function openModal(e: MouseEvent, href: string) {
  // let ctrl/cmd/middle clicks open the real page in a new tab
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const id = href.split('/').pop()!;
  pushState(href, { modalId: id });
}
