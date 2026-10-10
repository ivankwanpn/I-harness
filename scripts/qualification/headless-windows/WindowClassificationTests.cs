using System;
using System.Collections.Generic;
using System.IO;

class WindowClassificationTests {
  static int passed, failed;
  static List<string> lines = new List<string>();
  static WindowRelation Observed() {
    return new WindowRelation { exists=true, sameWindow=false, pid=42, windowClass="OwnedFixtureWindow",
      processStart="2026-10-08T00:00:00Z", queryState="observed", visible=false,
      windowHasArea=true, clientHasArea=true, cloaked=false, iconic=false, processStartedAfterObserver=true };
  }
  static WindowObservation Pseudo(WindowRelation owner) {
    return new WindowObservation { valid=true, windowClass="PseudoConsoleWindow", visible=true,
      messageOnly=false, windowHasArea=false, clientHasArea=false, cloaked=false, iconic=false,
      rootWindow=Observed(), ownerWindow=owner };
  }
  static void Check(string name, WindowObservation item, bool unknown, bool acceptable, bool newVisibleHost=false) {
    var actual = WindowClassification.Classify(item);
    if(actual.unknown==unknown && actual.acceptable==acceptable && actual.newVisibleHost==newVisibleHost) {
      passed++; lines.Add("PASS " + name);
    } else {
      failed++; lines.Add("FAIL " + name + ": unknown=" + actual.unknown + ", acceptable=" + actual.acceptable + ", newVisibleHost=" + actual.newVisibleHost);
    }
  }
  static int Main(string[] args) {
    Check("zero-area pseudo cannot hide null owner", Pseudo(null), true, false);
    Check("failed lookup differs from known no-owner", Pseudo(new WindowRelation { queryState="unknown" }), true, false);
    Check("known no-owner is explicit", Pseudo(new WindowRelation { exists=false, queryState="known-none" }), false, true);
    var stale=Observed(); stale.queryState="unknown-stale";
    Check("stale owner metadata fails", Pseudo(stale), true, false);
    Check("fully observed hidden host", Pseudo(Observed()), false, true);
    foreach(var field in new[] { "visible", "windowHasArea", "clientHasArea", "cloaked", "iconic", "processStartedAfterObserver", "processStart", "windowClass", "queryState", "exists" }) {
      var owner=Observed(); typeof(WindowRelation).GetField(field).SetValue(owner,null);
      Check("missing owner " + field, Pseudo(owner), true, false);
    }
    var unknownRoot=Pseudo(Observed()); unknownRoot.rootWindow.cloaked=null;
    Check("unknown associated root", unknownRoot, true, false);
    var noRoot=Pseudo(Observed()); noRoot.rootWindow=new WindowRelation { exists=false, queryState="known-none" };
    Check("root cannot be known-none", noRoot, true, false);
    var mainStale=Pseudo(Observed()); mainStale.valid=false;
    Check("stale main window", mainStale, true, false);
    var mainMissing=Pseudo(Observed()); mainMissing.windowHasArea=null;
    Check("missing main area", mainMissing, true, false);
    var visible=Observed(); visible.visible=true;
    Check("new visible hosting window", Pseudo(visible), false, false, true);
    var cloaked=Observed(); cloaked.visible=true; cloaked.cloaked=true;
    Check("fully observed cloaked hosting window", Pseudo(cloaked), false, true);
    var inconsistent=Observed(); inconsistent.queryState="known-none"; inconsistent.exists=false;
    Check("no-owner state cannot retain an owner identity", Pseudo(inconsistent), true, false);
    lines.Add("RESULT passed="+passed+" failed="+failed);
    File.WriteAllLines(args[0],lines);
    return failed==0?0:1;
  }
}
