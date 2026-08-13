export const INTERACTIONS_CHANGED_EVENT = "mission-control:interactions-changed";

export function announceInteractionsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(INTERACTIONS_CHANGED_EVENT));
}
