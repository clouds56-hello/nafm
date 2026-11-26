import { useLayoutEffect, useRef } from "react";

export function focusSettingsControl(control: HTMLElement | null, feedback?: HTMLElement | null) {
  feedback?.scrollIntoView({ block: "nearest", inline: "nearest" });
  control?.focus({ preventScroll: true });
  control?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function useSettingsActionFocus(busy: boolean) {
  const pending = useRef<{ opener: HTMLButtonElement; followUp?: () => void } | null>(null);

  useLayoutEffect(() => {
    const request = pending.current;
    if (busy || !request?.followUp) return;
    function restore() {
      if (!request || pending.current !== request) return;
      pending.current = null;
      const active = document.activeElement;
      if (active === request.opener || active === document.body || active === request.opener.closest("dialog")) {
        request.followUp?.();
      }
    }

    const authentication = document.querySelector<HTMLDialogElement>(".ssh-auth-dialog[open]");
    if (!authentication) {
      restore();
      return;
    }
    // The native prompt still makes Settings inert until its close and focus restoration finish.
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (authentication.isConnected && authentication.open) return;
      observer.disconnect();
      frame = requestAnimationFrame(restore);
    });
    observer.observe(authentication, { attributeFilter: ["open"] });
    if (authentication.parentElement) observer.observe(authentication.parentElement, { childList: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  });

  return {
    begin(opener: HTMLButtonElement | null) {
      if (!opener) return;
      opener.focus({ preventScroll: true });
      pending.current = { opener };
    },
    finish(followUp: () => void) {
      if (pending.current) pending.current.followUp = followUp;
    },
  };
}
