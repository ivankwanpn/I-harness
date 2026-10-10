// Pure metadata classification. This file does not query Windows or launch processes.
class WindowRelation {
  public bool? exists;
  public bool sameWindow;
  public uint pid;
  public string windowClass, processStart, queryState;
  public bool? visible, windowHasArea, clientHasArea, cloaked, iconic, processStartedAfterObserver;
}

class WindowObservation {
  public bool valid;
  public string windowClass;
  public bool? visible, messageOnly, windowHasArea, clientHasArea, cloaked, iconic;
  public WindowRelation rootWindow, ownerWindow;
}

class WindowClassification {
  public bool unknown, visibleConsole, visiblePseudo, nonDisplayingPseudo, newVisibleHost;
  public bool acceptable { get { return !unknown && !visibleConsole && (!visiblePseudo || nonDisplayingPseudo) && !newVisibleHost; } }

  public static bool ObservedRelation(WindowRelation item) {
    return item != null && item.queryState == "observed" && item.exists == true && item.pid != 0
      && !System.String.IsNullOrEmpty(item.windowClass) && !System.String.IsNullOrEmpty(item.processStart)
      && item.visible.HasValue && item.windowHasArea.HasValue && item.clientHasArea.HasValue
      && item.cloaked.HasValue && item.iconic.HasValue && item.processStartedAfterObserver.HasValue;
  }

  static bool KnownNoOwner(WindowRelation item) {
    return item != null && item.queryState == "known-none" && item.exists == false && item.pid == 0
      && !item.sameWindow && item.windowClass == null && item.processStart == null
      && !item.visible.HasValue && !item.windowHasArea.HasValue && !item.clientHasArea.HasValue
      && !item.cloaked.HasValue && !item.iconic.HasValue && !item.processStartedAfterObserver.HasValue;
  }

  public static WindowClassification Classify(WindowObservation item) {
    var result = new WindowClassification();
    if(item == null) { result.unknown = true; return result; }
    result.unknown = !item.valid || System.String.IsNullOrEmpty(item.windowClass)
      || !item.visible.HasValue || !item.messageOnly.HasValue || !item.windowHasArea.HasValue
      || !item.clientHasArea.HasValue || !item.cloaked.HasValue || !item.iconic.HasValue
      || !ObservedRelation(item.rootWindow)
      || !(KnownNoOwner(item.ownerWindow) || ObservedRelation(item.ownerWindow));
    result.visibleConsole = item.visible == true && item.windowClass == "ConsoleWindowClass";
    result.visiblePseudo = item.visible == true && item.windowClass == "PseudoConsoleWindow";
    // Unknown hosting metadata always fences acceptance, even for a zero-area
    // or message-only pseudo window. Class names do not exempt unknown owners.
    if(result.unknown) return result;
    result.nonDisplayingPseudo = result.visiblePseudo && (item.messageOnly == true || item.windowHasArea == false || item.cloaked == true);
    var owner = item.ownerWindow;
    result.newVisibleHost = owner != null && owner.visible == true && owner.windowHasArea == true && owner.cloaked == false && owner.processStartedAfterObserver == true;
    return result;
  }
}
