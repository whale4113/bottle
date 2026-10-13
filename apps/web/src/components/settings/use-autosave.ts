import { useEffect, useRef, useState } from "react";

/** Keep drafts mounted while navigating; serialize writes through the form's busy state. */
export function useAutosave(save: () => Promise<boolean>, busy: boolean) {
  const [revision, setRevision] = useState(0);
  const [savedRevision, setSavedRevision] = useState(0);
  const attempted = useRef(0);
  const latestSave = useRef(save);
  latestSave.current = save;
  const pending = revision !== savedRevision;

  useEffect(() => {
    if (!pending || busy || attempted.current === revision) return;
    const timer = window.setTimeout(() => {
      attempted.current = revision;
      void latestSave.current().then((success) => {
        if (success) setSavedRevision(revision);
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [revision, pending, busy]);

  return { pending, changed: () => setRevision((value) => value + 1) };
}
