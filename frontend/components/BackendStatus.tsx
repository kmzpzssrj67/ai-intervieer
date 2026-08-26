"use client";

export default function BackendStatus({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold">
      <span
        className={`h-2.5 w-2.5 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`}
      />
      <span>{connected ? "Backend online" : "Backend offline"}</span>
    </div>
  );
}
