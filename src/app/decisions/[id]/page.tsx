import { Suspense } from "react";
import DecisionView from "./decision-view";

export default function DecisionPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground">正在打开复盘……</p>}>
      <DecisionView />
    </Suspense>
  );
}
