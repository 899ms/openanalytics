import type { Metadata } from "next";
import { FirstEventGate } from "@/components/dashboard/awaiting-events";
import { RealtimeBoard } from "@/components/dashboard/realtime-board";

export const metadata: Metadata = {
  title: "Realtime | Open Analytics",
};

export default function RealtimePage() {
  // An empty room and a quiet minute look identical here, so a site that has
  // never received an event says which one it is instead of drawing zero.
  return (
    <FirstEventGate surface="realtime">
      <RealtimeBoard />
    </FirstEventGate>
  );
}
