// Lets the sidebar title-row search icon focus the Activity view's inline
// thread search without either component owning the other's refs.
type Listener = () => void;
const listeners = new Set<Listener>();

export function requestSidebarSearchFocus(): boolean {
  for (const listener of listeners) listener();
  return listeners.size > 0;
}

export function subscribeSidebarSearchFocus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
