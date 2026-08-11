"use client";

import { Toaster } from "sonner";

export function ToasterProvider() {
  // Keep transient errors below the mobile header/menu trigger.  Sonner
  // expands to a full-width toast on narrow screens, so its close button must
  // not occupy the same hit target as the workspace menu.
  const offset = { top: 72, right: 16, bottom: 16, left: 16 };
  return <Toaster position="top-right" richColors closeButton offset={offset} mobileOffset={offset} />;
}
