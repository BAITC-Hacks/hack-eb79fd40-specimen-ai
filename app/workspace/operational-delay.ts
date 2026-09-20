"use client";

import { useEffect, useState } from "react";
import type { ReferralDetail } from "@/lib/referrals/types";
import { exceedsOperationalDelay } from "./client";

const CHANGE_EVENT = "demeu:operational-delay-changed";

export function isOperationallyDelayed(record: Pick<ReferralDetail, "cancelled" | "attendance" | "observedStageDays">, threshold: string): boolean {
  return !record.cancelled && record.attendance === null && exceedsOperationalDelay(record.observedStageDays, threshold);
}

function storageKey(organizationId: string, actorId: string): string {
  return `demeu:operational-delay:v1:${encodeURIComponent(organizationId)}:${encodeURIComponent(actorId)}`;
}

function validThreshold(value: string): boolean {
  return value === "" || (value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0);
}

export function useOperationalDelay(organizationId: string, actorId: string): [string, (value: string) => void] {
  const key = storageKey(organizationId, actorId);
  const [current, setCurrent] = useState({ key: "", value: "" });

  useEffect(() => {
    const read = () => {
      try {
        const value = window.localStorage.getItem(key) ?? "";
        setCurrent({ key, value: validThreshold(value) ? value : "" });
      } catch {
        setCurrent({ key, value: "" });
      }
    };
    const onStorage = (event: StorageEvent) => { if (event.key === key) read(); };
    const onChange = () => read();
    read();
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, [key]);

  const setThreshold = (value: string) => {
    if (!validThreshold(value)) return;
    setCurrent({ key, value });
    try {
      if (value === "") window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      // The current tab still uses the chosen threshold when storage is unavailable.
    }
  };

  return [current.key === key ? current.value : "", setThreshold];
}
