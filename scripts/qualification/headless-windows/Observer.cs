// Owned GUI-subsystem qualification fixture. No titles, window text, screenshots,
// command lines, or unrelated process metadata are recorded.
using System;
using System.IO;
using System.Diagnostics;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

class Observer {
  delegate void WinEvent(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
  delegate bool EnumWindow(IntPtr hwnd, IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent cb, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder cls, int length);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint command);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,uint attribute,out uint value,uint size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow cb, IntPtr value);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
    public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe;
  }
  static Dictionary<uint, uint> owned = new Dictionary<uint,uint>();
  static Dictionary<uint, string> starts = new Dictionary<uint,string>();
  static HashSet<string> sampled = new HashSet<string>();
  static StreamWriter log;
  static string phase = "startup";
  static uint desktop;
  static int positive, visibleConsole;
  static int visiblePseudo, messageOnlyPseudo;
  static int nonDisplayingPseudo;
  static int newVisibleHostingWindows;
  static DateTime observerStart=Process.GetCurrentProcess().StartTime.ToUniversalTime();
  static int unknownOwnedShows;
  static string fixturePath;
  static List<Process> launched = new List<Process>();
  static JavaScriptSerializer json = new JavaScriptSerializer();
  static void Snapshot() {
    IntPtr h = CreateToolhelp32Snapshot(2,0); if(h == new IntPtr(-1)) return;
    var all = new List<Entry>(); var e = new Entry(); e.size=(uint)Marshal.SizeOf(e);
    if(Process32FirstW(h,ref e)) do { all.Add(e); } while(Process32NextW(h,ref e));
    CloseHandle(h);
    for(int i=0;i<5;i++) foreach(var p in all) if(owned.ContainsKey(p.parent) && SameGeneration(p.parent) && !owned.ContainsKey(p.pid)) Add(p.pid,p.parent);
  }
  static bool SameGeneration(uint pid) { try {return Process.GetProcessById((int)pid).StartTime.ToUniversalTime().ToString("o")==starts[pid];}catch{return false;} }
  class WindowRelation {public bool exists,sameWindow;public uint pid;public string windowClass,processStart;public bool? visible,windowHasArea,clientHasArea,cloaked,processStartedAfterObserver;}
  static WindowRelation Relation(IntPtr handle,IntPtr original) {
    if(handle==IntPtr.Zero)return new WindowRelation {exists=false};uint pid;GetWindowThreadProcessId(handle,out pid);
    var cls=new StringBuilder(256);GetClassName(handle,cls,cls.Capacity);Rect wr,cr;uint cloak;
    var result=new WindowRelation {exists=true,sameWindow=handle==original,pid=pid,windowClass=cls.ToString(),visible=IsWindow(handle)?(bool?)IsWindowVisible(handle):null,
      windowHasArea=GetWindowRect(handle,out wr)?(bool?)(wr.right>wr.left&&wr.bottom>wr.top):null,
      clientHasArea=GetClientRect(handle,out cr)?(bool?)(cr.right>cr.left&&cr.bottom>cr.top):null,
      cloaked=DwmGetWindowAttribute(handle,14,out cloak,4)==0?(bool?)(cloak!=0):null};
    try{var start=Process.GetProcessById((int)pid).StartTime.ToUniversalTime();result.processStart=start.ToString("o");result.processStartedAfterObserver=start>observerStart;}catch{}
    return result;
  }
  static void Add(uint pid,uint parent) {
    owned[pid]=parent;
    try { starts[pid]=Process.GetProcessById((int)pid).StartTime.ToUniversalTime().ToString("o"); }
    catch { starts[pid]="unavailable"; }
  }
  static void Window(IntPtr hwnd,string kind) {
    // Query transient HWND metadata before process enumeration can delay the callback.
    bool validBefore=IsWindow(hwnd);
    uint pid; GetWindowThreadProcessId(hwnd,out pid);
    var cls=new StringBuilder(256); GetClassName(hwnd,cls,cls.Capacity); string name=cls.ToString(); bool visible=IsWindowVisible(hwnd);
    bool messageOnly=false;IntPtr next=IntPtr.Zero;
    while((next=FindWindowEx(new IntPtr(-3),next,null,null))!=IntPtr.Zero) if(next==hwnd) {messageOnly=true;break;}
    Rect wr,cr;bool? windowHasArea=GetWindowRect(hwnd,out wr)?(bool?)(wr.right>wr.left&&wr.bottom>wr.top):null;
    bool? clientHasArea=GetClientRect(hwnd,out cr)?(bool?)(cr.right>cr.left&&cr.bottom>cr.top):null;
    uint cloak;bool? cloaked=DwmGetWindowAttribute(hwnd,14,out cloak,4)==0?(bool?)(cloak!=0):null;
    bool iconic=IsIconic(hwnd);var rootWindow=Relation(GetAncestor(hwnd,2),hwnd);var ownerWindow=Relation(GetWindow(hwnd,4),hwnd);
    bool valid=validBefore && IsWindow(hwnd) && name.Length>0;
    if(kind=="show") Snapshot(); if(!owned.ContainsKey(pid)) return;
    if(!SameGeneration(pid))valid=false;
    if(kind=="show" && !valid)unknownOwnedShows++;
    if(kind=="sample" && (name!="ConsoleWindowClass" || !sampled.Add(pid+":"+name+":"+visible))) return;
    if(kind=="show" && visible && pid==desktop && name.StartsWith("Chrome_WidgetWin")) positive++;
    if(kind=="show" && visible && name=="ConsoleWindowClass") visibleConsole++;
    if(kind=="show" && visible && name=="PseudoConsoleWindow") {visiblePseudo++;if(messageOnly)messageOnlyPseudo++;}
    if(kind=="show" && valid && visible && name=="PseudoConsoleWindow" && (messageOnly||windowHasArea==false||cloaked==true))nonDisplayingPseudo++;
    if(kind=="show" && ownerWindow.visible==true && ownerWindow.windowHasArea==true && ownerWindow.cloaked==false && ownerWindow.processStartedAfterObserver==true)newVisibleHostingWindows++;
    log.WriteLine(json.Serialize(new { utc=DateTime.UtcNow.ToString("o"), phase=phase, kind=kind, pid=pid, parent=owned[pid], start=starts[pid], windowClass=name, hwnd=hwnd.ToInt64().ToString(), queryState=valid?"observed":"unknown-destroyed", visible=valid?(bool?)visible:null, messageOnly=valid?(bool?)messageOnly:null, windowHasArea=valid?windowHasArea:null,clientHasArea=valid?clientHasArea:null,cloaked=valid?cloaked:null,iconic=valid?(bool?)iconic:null,rootWindow=rootWindow,ownerWindow=ownerWindow })); log.Flush();
  }
  static void Pump() { Snapshot(); Application.DoEvents(); EnumWindows((h,v)=>{Window(h,"sample");return true;},IntPtr.Zero); Thread.Sleep(5); }
  static Process Launch(string exe,string args,string cwd,bool node) {
    var info=new ProcessStartInfo(exe,args); info.WorkingDirectory=cwd; info.UseShellExecute=false;
    info.CreateNoWindow=true; info.WindowStyle=ProcessWindowStyle.Hidden;
    info.RedirectStandardError=true; info.RedirectStandardOutput=true;
    if(node) info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"]="1"; else info.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
    var p=Process.Start(info); launched.Add(p); Add((uint)p.Id,(uint)Process.GetCurrentProcess().Id);
    string label=node?"worker":"desktop";
    p.ErrorDataReceived+=(s,e)=>{if(e.Data!=null) lock(launched) File.AppendAllText(Path.Combine(fixturePath,label+"-stderr.log"),e.Data+Environment.NewLine);};
    p.OutputDataReceived+=(s,e)=>{if(e.Data!=null) lock(launched) File.AppendAllText(Path.Combine(fixturePath,label+"-stdout.log"),e.Data+Environment.NewLine);};
    p.BeginErrorReadLine();p.BeginOutputReadLine();return p;
  }
  [STAThread] static int Main(string[] args) {
    string fixture=args[0], app=args[1], worker=args[2], loader=args[3], repo=args[4];
    fixturePath=fixture;
    Directory.CreateDirectory(fixture); log=new StreamWriter(Path.Combine(fixture,"window-events.ndjson"));
    Add((uint)Process.GetCurrentProcess().Id,0);
    WinEvent callback=(hook,evt,hwnd,obj,child,thread,time)=> { if(hwnd!=IntPtr.Zero && obj==0 && child==0) Window(hwnd,"show"); };
    IntPtr handle=SetWinEventHook(0x8002,0x8002,IntPtr.Zero,callback,0,0,0);
    try {
      if(GetConsoleWindow()!=IntPtr.Zero)throw new Exception("Observer must have no console");
      if(handle==IntPtr.Zero)throw new Exception("WinEvent hook unavailable");
      phase="desktop-positive";
      var ui=Launch(app,"--user-data-dir=\""+Path.Combine(fixture,"desktop-profile")+"\"",fixture,false); desktop=(uint)ui.Id;
      DateTime deadline=DateTime.UtcNow.AddSeconds(40); while(positive==0 && !ui.HasExited && DateTime.UtcNow<deadline) Pump();
      if(positive==0) throw new Exception("Desktop SHOW positive control failed");
      EnumWindows((h,v)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid==desktop)PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);return true;},IntPtr.Zero);
      deadline=DateTime.UtcNow.AddSeconds(30); while(!ui.HasExited && DateTime.UtcNow<deadline) Pump();
      if(!ui.HasExited) throw new Exception("Desktop did not close");
      phase="hidden-workloads";
      var task=Launch(app,"--import \""+loader+"\" \""+worker+"\" \""+fixture+"\" \""+repo+"\"",repo,true);
      deadline=DateTime.UtcNow.AddMinutes(4); while(!task.HasExited && DateTime.UtcNow<deadline) Pump();
      if(!task.HasExited) throw new Exception("Workload timed out; owned process requires cleanup");
      for(int i=0;i<40;i++) Pump();
      var live=new List<uint>();foreach(uint pid in owned.Keys) if(pid!=(uint)Process.GetCurrentProcess().Id) try {var p=Process.GetProcessById((int)pid);if(!p.HasExited && p.StartTime.ToUniversalTime().ToString("o")==starts[pid])live.Add(pid);}catch{}
      File.WriteAllText(Path.Combine(fixture,"observer-result.json"),json.Serialize(new { guiParentHasConsole=false,positiveDesktopShows=positive, visibleConsoleShows=visibleConsole, visiblePseudoShows=visiblePseudo, messageOnlyPseudoShows=messageOnlyPseudo,nonDisplayingPseudoShows=nonDisplayingPseudo,newVisibleHostingWindows=newVisibleHostingWindows, unknownOwnedShows=unknownOwnedShows, workloadExit=task.ExitCode, liveOwnedPids=live, ownedPids=owned.Keys }));
      return task.ExitCode==0 && visibleConsole==0 && visiblePseudo==nonDisplayingPseudo && newVisibleHostingWindows==0 && unknownOwnedShows==0 && live.Count==0 ? 0 : 1;
    } catch(Exception e) { File.WriteAllText(Path.Combine(fixture,"observer-error.txt"),e.ToString()); return 2; }
    finally { foreach(var p in launched) if(!p.HasExited && (uint)p.Id==desktop) {p.Kill();p.WaitForExit(5000);} UnhookWinEvent(handle); GC.KeepAlive(callback); log.Dispose(); }
  }
}
