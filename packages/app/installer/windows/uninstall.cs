// The uninstaller of BUSY Bar Emulator for Windows (EMU-218), the other half of setup.cs and compiled with it into one
// program. That program without an app at its end is the uninstaller: the setup writes itself, without the app, into
// every folder it installs as uninstall.exe, and names it in the entry it makes under
// HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall (what Settings -> Apps shows and runs). The setup itself
// does the same with /Uninstall.
//
//   uninstall.exe [/S] [/KeepData | /RemoveData] [/LOG=<file>] [/D=<folder>]
//
//   /S            silent: no question and no window; the result is the exit code and the log
//   /KeepData     the data folder stays (the default in silent mode)
//   /RemoveData   the data folder goes too: the emulated bar's storage with the apps installed on it, the list of
//                 trusted projects, npm's cache, the logs. Without /S the uninstaller asks.
//   /LOG=<file>   where the log goes, added to the file; by default %TEMP%\busybar-emulator-setup.log, which a
//                 successful removal deletes
//   /D=<folder>   the app's folder, last on the line; by default the folder uninstall.exe lies in (for the setup with
//                 /Uninstall: the folder the entry names, or the default one)
//
// What it does, in order: refuses while a busy-emulator command runs from the folder (a project build, the dev loop);
// quits the running emulator through its own command line (busy-emulator quit; no process is ended by its name);
// moves itself out of the folder; takes the folder away whole (a rename: with a file of it still in use nothing is
// changed) and removes it; removes the Start menu shortcut and the entry in Settings -> Apps when they name this
// folder, the command line's folder (%LOCALAPPDATA%\busy-emulator) when it runs this copy, the pointer file in the
// data folder when it names this copy, the data folder when asked, and the setup's log. It removes only a folder the setup made (its marker
// inside).
//
// Exit codes: 0 removed, 1 failed (the log says what is left), 2 wrong arguments or a folder that is not an install of
// the setup's, 3 the emulator or a command of it is running from the folder and did not end (nothing was removed),
// 4 the user said no.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Uninstall
{
    /// <summary>The uninstaller's name in the app's folder.</summary>
    internal const string FileName = "uninstall.exe";
    internal const string KeyPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\app.busy.emulator";
    private const string Publisher = "Flipper FZCO";
    /// <summary>The name of the folder of the command line's launcher under %LOCALAPPDATA% (ADR-0002, section 7a).</summary>
    private const string LauncherFolderName = "busy-emulator";
    private const string DefaultLogName = "busybar-emulator-setup.log";
    private const int QuitWaitMs = 45000;
    private const int GoneWaitMs = 15000;
    /// <summary>Where this program's own file is once it has moved out of the app's folder, or null.</summary>
    private static string movedSelf;

    private static void Log(string line) { Setup.Log(line); }

    private static string Local()
    {
        return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    }

    /// <summary>The user's data folder: where a release keeps it (packages/app/src/config.mjs).</summary>
    internal static string DataFolder()
    {
        return Path.Combine(Local(), Setup.AppName);
    }

    internal static string LauncherFolder()
    {
        return Path.Combine(Local(), LauncherFolderName);
    }

    private static bool SamePath(string a, string b)
    {
        if (a == null || b == null) return false;
        return string.Equals(a.Trim().TrimEnd('\\'), b.Trim().TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    }

    private static bool Inside(string path, string folder)
    {
        return path != null && path.StartsWith(folder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    // ------------------------------------------------------------------------------------- the entry in Settings

    /// <summary>
    /// The entry Settings -> Apps shows for the current user. It names the uninstaller in the app's folder; an install
    /// made with /NoShortcut (a copy that is not the user's own) has none.
    /// </summary>
    internal static void Register(string folder, long bytes)
    {
        string uninstaller = Path.Combine(folder, FileName);
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(KeyPath))
        {
            key.SetValue("DisplayName", Setup.AppName);
            key.SetValue("DisplayVersion", SetupInfo.Version);
            key.SetValue("Publisher", Publisher);
            key.SetValue("InstallLocation", folder);
            key.SetValue("DisplayIcon", Path.Combine(folder, Setup.ExeName));
            key.SetValue("UninstallString", "\"" + uninstaller + "\"");
            key.SetValue("QuietUninstallString", "\"" + uninstaller + "\" /S");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            key.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, bytes / 1024), RegistryValueKind.DWord);
            key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
        }
    }

    /// <summary>The folder the entry names, or null.</summary>
    internal static string RegisteredFolder()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(KeyPath))
            {
                return key == null ? null : key.GetValue("InstallLocation") as string;
            }
        }
        catch (Exception)
        {
            return null;
        }
    }

    // ------------------------------------------------------------------------------- what runs from the folder

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private const uint TH32CS_SNAPPROCESS = 2;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    internal sealed class Running
    {
        public uint Id;
        public uint Parent;
        public string Path;
        /// <summary>The app itself, or a process the app started (its helpers, its server).</summary>
        public bool OfApp;
        public override string ToString() { return "process " + Id + " (" + Path + ")"; }
    }

    /// <summary>
    /// The processes of this user whose program lies in the folder, found by the program's full path, never by its
    /// name; this process is left out. Each is marked as the app's (the app's executable, or started by it) or not:
    /// what is not the app's is a command — the command line run by a person or an agent, a build, the dev loop.
    /// </summary>
    internal static List<Running> RunningFrom(string folder)
    {
        Dictionary<uint, Running> all = new Dictionary<uint, Running>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == InvalidHandle) throw new IOException("the list of processes cannot be read: " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
        try
        {
            PROCESSENTRY32W entry = new PROCESSENTRY32W();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            bool more = Process32FirstW(snapshot, ref entry);
            while (more)
            {
                Running r = new Running();
                r.Id = entry.th32ProcessID;
                r.Parent = entry.th32ParentProcessID;
                all[r.Id] = r;
                more = Process32NextW(snapshot, ref entry);
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }
        uint self = (uint)Process.GetCurrentProcess().Id;
        string app = Path.Combine(folder, Setup.ExeName);
        List<Running> inside = new List<Running>();
        foreach (Running r in all.Values)
        {
            if (r.Id == self || r.Id == 0) continue;
            // A process of another user or of the system does not open: it does not run from this user's folder.
            IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, r.Id);
            if (handle == IntPtr.Zero) continue;
            try
            {
                StringBuilder name = new StringBuilder(32768);
                uint size = (uint)name.Capacity;
                if (QueryFullProcessImageNameW(handle, 0, name, ref size)) r.Path = name.ToString();
            }
            finally
            {
                CloseHandle(handle);
            }
            if (Inside(r.Path, folder)) inside.Add(r);
        }
        foreach (Running r in inside)
        {
            Running at = r;
            for (int depth = 0; depth < 32 && at != null; depth++)
            {
                if (SamePath(at.Path, app)) { r.OfApp = true; break; }
                Running parent;
                if (at.Parent == 0 || at.Parent == at.Id || !all.TryGetValue(at.Parent, out parent)) break;
                at = parent;
            }
        }
        return inside;
    }

    private static string Describe(List<Running> list)
    {
        List<string> parts = new List<string>();
        foreach (Running r in list)
        {
            if (parts.Count == 4) { parts.Add("and " + (list.Count - 4) + " more"); break; }
            parts.Add(r.ToString());
        }
        return string.Join(", ", parts.ToArray());
    }

    /// <summary>
    /// Ends the running emulator the way its own Quit does it for a program: `busy-emulator quit`, by the command line
    /// inside the app. Gives what the command said; a command that does not end in time is ended (a process this
    /// program started itself, by its handle).
    /// </summary>
    private static void QuitThroughCommandLine(string folder)
    {
        string cli = Path.Combine(Path.Combine(Path.Combine(folder, "resources"), "bin"), "busy-emulator.exe");
        if (!File.Exists(Setup.Long(cli)))
        {
            Log("no command line at " + cli + ": the emulator is not asked to quit");
            return;
        }
        ProcessStartInfo start = new ProcessStartInfo(cli, "quit");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        start.RedirectStandardInput = true;
        start.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
        StringBuilder said = new StringBuilder();
        DataReceivedEventHandler take = delegate (object sender, DataReceivedEventArgs e)
        {
            if (e.Data != null) lock (said) { if (said.Length < 4000) said.Append(e.Data).Append(' '); }
        };
        using (Process child = new Process())
        {
            child.StartInfo = start;
            child.OutputDataReceived += take;
            child.ErrorDataReceived += take;
            child.Start();
            child.StandardInput.Close();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            if (!child.WaitForExit(QuitWaitMs))
            {
                Log("busy-emulator quit did not end within " + (QuitWaitMs / 1000) + " s; it is ended");
                try { child.Kill(); } catch (Exception) { }
                child.WaitForExit(5000);
                return;
            }
            child.WaitForExit();
            string text;
            lock (said) { text = said.ToString().Trim(); }
            Log("busy-emulator quit: exit code " + child.ExitCode + (text.Length > 0 ? ": " + text : ""));
        }
    }

    // ------------------------------------------------------------------------------------------- what is removed

    private static void RemoveWithRetries(string path)
    {
        for (int i = 0; ; i++)
        {
            try
            {
                Setup.RemoveTree(path);
                return;
            }
            catch (Exception)
            {
                // A file that a virus scanner or the indexer holds for a moment.
                if (i >= 5) throw;
                Thread.Sleep(500);
            }
        }
    }

    private static bool Exists(string path)
    {
        return Directory.Exists(Setup.Long(path)) || File.Exists(Setup.Long(path));
    }

    /// <summary>The Start menu shortcut goes when it starts the app in this folder; one that starts another copy stays.</summary>
    private static void RemoveShortcut(string folder, List<string> left)
    {
        string link = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Setup.AppName + ".lnk");
        if (!File.Exists(link)) return;
        try
        {
            Type type = Type.GetTypeFromProgID("WScript.Shell");
            if (type == null) throw new IOException("Windows has no WScript.Shell to read the shortcut with");
            object shell = Activator.CreateInstance(type);
            object shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { link });
            string target = shortcut.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, shortcut, null) as string;
            if (!SamePath(target, Path.Combine(folder, Setup.ExeName)))
            {
                Log("left alone, it starts another copy (" + target + "): " + link);
                return;
            }
            File.Delete(link);
            Log("removed the shortcut " + link);
        }
        catch (Exception e)
        {
            Log("could not remove the shortcut " + link + ": " + e.Message);
            left.Add(link);
        }
    }

    private static void RemoveEntry(string folder, List<string> left)
    {
        string registered = RegisteredFolder();
        if (registered == null) return;
        if (!SamePath(registered, folder))
        {
            Log("left alone, it names another copy (" + registered + "): the entry in Settings, HKCU\\" + KeyPath);
            return;
        }
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree(KeyPath, false);
            Log("removed the entry in Settings, HKCU\\" + KeyPath);
        }
        catch (Exception e)
        {
            Log("could not remove the entry HKCU\\" + KeyPath + ": " + e.Message);
            left.Add("HKCU\\" + KeyPath);
        }
    }

    /// <summary>
    /// The command line's folder, %LOCALAPPDATA%\busy-emulator, goes when its launcher runs this copy: the first line
    /// of busy-emulator.launch is this copy's Node. A launcher of another copy stays: that copy wrote it when it
    /// started last.
    /// </summary>
    private static void RemoveLauncher(string folder, List<string> left)
    {
        string launcher = LauncherFolder();
        if (!Directory.Exists(launcher)) return;
        string launch = Path.Combine(Path.Combine(launcher, "bin"), "busy-emulator.launch");
        try
        {
            if (Setup.IsLink(launcher)) { Log("left alone, it is a link: " + launcher); return; }
            if (!File.Exists(launch)) { Log("left alone, it holds no busy-emulator.launch: " + launcher); return; }
            string[] lines = File.ReadAllLines(launch, new UTF8Encoding(false));
            string node = lines.Length > 0 ? lines[0].Trim() : "";
            if (!Inside(node, folder))
            {
                Log("left alone, it runs another copy (" + node + "): " + launcher);
                return;
            }
            RemoveWithRetries(launcher);
            Log("removed the command line's folder " + launcher);
        }
        catch (Exception e)
        {
            Log("could not remove " + launcher + ": " + e.Message);
            left.Add(launcher);
        }
    }

    /// <summary>Whether the folder is an emulator's data folder: it holds what the server or the app writes at once.</summary>
    private static bool LooksLikeData(string data)
    {
        return File.Exists(Path.Combine(data, "format")) || File.Exists(Path.Combine(data, "install.json")) || File.Exists(Path.Combine(Path.Combine(data, "logs"), "shell.log"));
    }

    private static void RemoveData(string folder, bool whole, List<string> left)
    {
        string data = DataFolder();
        if (!Directory.Exists(data)) return;
        try
        {
            if (whole)
            {
                if (Setup.IsLink(data))
                {
                    // Only the link goes: what it points to is the user's choice of a place, and is not entered.
                    Setup.RemoveTree(data);
                    Log("removed the link " + data + "; what it pointed to is not touched");
                    return;
                }
                if (!LooksLikeData(data))
                {
                    Log("left alone, it does not look like the emulator's data folder: " + data);
                    left.Add(data);
                    return;
                }
                RemoveWithRetries(data);
                Log("removed the data folder " + data);
                return;
            }
            // The data stay, but not the pointer to an app that is gone: agents read it to find the command line.
            string pointer = Path.Combine(data, "install.json");
            if (File.Exists(pointer) && File.ReadAllText(pointer).Replace("\\\\", "\\").IndexOf(folder.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                File.Delete(pointer);
                Log("removed the pointer file " + pointer);
            }
            Log("the data folder stays: " + data);
        }
        catch (Exception e)
        {
            Log("could not remove " + (whole ? data : Path.Combine(data, "install.json")) + ": " + e.Message);
            left.Add(data);
        }
    }

    /// <summary>
    /// A running program cannot delete its own file, so this one, moved out of the app's folder, leaves the deleting to
    /// cmd.exe (by its full path, started in the file's folder, with the file named without its path: no quoting of
    /// the user's own folder names is needed), two seconds after it ends.
    /// </summary>
    private static void DeleteSelfLater(string moved)
    {
        if (moved == null) return;
        try
        {
            string system = Environment.GetFolderPath(Environment.SpecialFolder.System);
            string name = Path.GetFileName(moved);
            ProcessStartInfo start = new ProcessStartInfo(Path.Combine(system, "cmd.exe"), "/d /s /c \"\"" + Path.Combine(system, "PING.EXE") + "\" -n 3 127.0.0.1 >nul & del /f /q " + name + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WorkingDirectory = Path.GetDirectoryName(moved);
            using (Process.Start(start)) { }
        }
        catch (Exception e)
        {
            Log("could not arrange for " + moved + " to be deleted: " + e.Message);
        }
    }

    // ------------------------------------------------------------------------------------------------- the run

    /// <param name="hasPayload">this program is the setup (run with /Uninstall), not the uninstaller in the app's folder</param>
    internal static int Run(Setup.Options options, bool hasPayload, string logFile, Action closeLog)
    {
        string title = "Uninstall " + Setup.AppName;
        string self = Assembly.GetExecutingAssembly().Location;
        string folder = Setup.CheckFolder(options.Folder ?? (hasPayload ? (RegisteredFolder() ?? Setup.DefaultFolder()) : Path.GetDirectoryName(self)));
        Log("uninstalling from " + folder + (options.Silent ? ", silent" : ""));
        if (!Directory.Exists(Setup.Long(folder))) throw new SetupError(2, Setup.AppName + " is not installed in " + folder + ". Nothing was removed.");
        if (Setup.IsLink(folder) || !Setup.HasMarker(folder)) throw new SetupError(2, folder + " is not an install of " + Setup.AppName + " made by its setup (it holds no " + Setup.MarkerName + "). Nothing was removed.");

        string data = DataFolder();
        bool hasData = Directory.Exists(data);
        bool removeData = options.RemoveData;
        if (!options.Silent)
        {
            DialogResult sure = MessageBox.Show("Remove " + Setup.AppName + " from this computer?\n\nIt is removed from " + folder + ", with its Start menu shortcut and its command line.", title, MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (sure != DialogResult.OK)
            {
                Log("the user said no");
                return 4;
            }
            if (hasData && !options.KeepData && !options.RemoveData)
            {
                DialogResult also = MessageBox.Show(
                    "Remove the emulator's data too?\n\n" + data + " holds the emulated BUSY Bar's storage (the apps installed on it and their settings), the list of projects you trusted, npm's cache and the logs.\n\nYes removes it. No keeps it for a later install. Your projects are not touched either way.",
                    title, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
                removeData = also == DialogResult.Yes;
            }
        }
        Log(removeData ? "the data folder goes too: " + data : "the data folder is kept: " + data);

        // 1. A command of the emulator that runs now (a build, the dev loop) is not cut off: the uninstaller refuses.
        List<Running> running = RunningFrom(folder);
        List<Running> commands = running.FindAll(delegate (Running r) { return !r.OfApp; });
        if (commands.Count > 0)
        {
            throw new SetupError(3, "A busy-emulator command is running from " + folder + " (a project build, the dev loop or another command): " + Describe(commands) + ". Wait for it to end or stop it, then run the uninstaller again. Nothing was removed.");
        }

        // 2. The emulator quits through its own command line.
        if (running.Count > 0)
        {
            Log("the emulator is running: " + Describe(running));
            QuitThroughCommandLine(folder);
            Stopwatch waited = Stopwatch.StartNew();
            while (true)
            {
                running = RunningFrom(folder);
                if (running.Count == 0 || waited.ElapsedMilliseconds > GoneWaitMs) break;
                Thread.Sleep(250);
            }
            if (running.Count > 0)
            {
                throw new SetupError(3, Setup.AppName + " is still running from " + folder + ": " + Describe(running) + ". Quit it (its menu, or busy-emulator quit) and run the uninstaller again. Nothing was removed.");
            }
            Log("the emulator has quit");
        }

        // 3. Out of the folder that is about to go: Windows lets a running program's file be moved, on its own disk.
        // From here on Finish(), the last thing Main does, has the moved file deleted.
        if (Inside(self, folder))
        {
            string name = "busybar-emulator-uninstall-" + Process.GetCurrentProcess().Id + ".exe";
            foreach (string to in new string[] { Path.Combine(Path.GetTempPath(), name), folder + ".uninstall-" + Process.GetCurrentProcess().Id + ".exe" })
            {
                try
                {
                    File.Move(Setup.Long(self), Setup.Long(to));
                    movedSelf = to;
                    break;
                }
                catch (Exception e)
                {
                    Log("the uninstaller could not move to " + to + ": " + e.Message);
                }
            }
            if (movedSelf == null) throw new SetupError(1, "The uninstaller could not move itself out of " + folder + ". Nothing was removed. The log is " + logFile + ".");
        }

        // 4. The folder, whole or not at all: with a file of it in use the rename fails and nothing has changed.
        string old = folder + ".old-" + Process.GetCurrentProcess().Id;
        try
        {
            Directory.Move(Setup.Long(folder), Setup.Long(old));
        }
        catch (Exception e)
        {
            if (movedSelf != null)
            {
                try
                {
                    File.Move(Setup.Long(movedSelf), Setup.Long(self));
                    movedSelf = null;
                }
                catch (Exception back)
                {
                    Log("could not move the uninstaller back to " + self + ": " + back.Message);
                }
            }
            if (!(e is IOException || e is UnauthorizedAccessException)) throw;
            if (!Setup.CanWriteBeside(folder)) throw new SetupError(1, "The uninstaller has no right to change " + folder + " (" + e.Message + "). Nothing was removed.");
            throw new SetupError(3, "A program is running from " + folder + ", or a file in it is open (" + e.Message + "). Quit " + Setup.AppName + ", close what uses the folder and run the uninstaller again. Nothing was removed.");
        }
        List<string> left = new List<string>();
        try
        {
            RemoveWithRetries(old);
            Log("removed the app's folder " + folder);
        }
        catch (Exception e)
        {
            Log("could not remove all of " + old + ": " + e.Message);
            left.Add(old);
        }

        // 5. What the app and the setup made outside the folder.
        RemoveShortcut(folder, left);
        RemoveLauncher(folder, left);
        RemoveData(folder, removeData, left);
        RemoveEntry(folder, left);

        bool keptData = Directory.Exists(data);
        if (left.Count > 0)
        {
            throw new SetupError(1, Setup.AppName + " is removed, but not all of it could be deleted. Delete by hand: " + string.Join(", ", left.ToArray()) + ". The log is " + logFile + ".");
        }
        Log("removed" + (keptData ? "; the data folder is kept: " + data : ""));
        if (!options.Silent)
        {
            MessageBox.Show(Setup.AppName + " is removed." + (keptData ? "\n\nIts data are kept in " + data + ". Delete that folder to remove them too." : ""), title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        // The setup's own log in the temporary folder goes last; a log the caller named is the caller's and stays.
        closeLog();
        try
        {
            File.Delete(Path.Combine(Path.GetTempPath(), DefaultLogName));
        }
        catch (Exception) { }
        return 0;
    }

    /// <summary>The last thing the program does, after its windows and its log: the moved uninstaller is to be deleted.</summary>
    internal static void Finish()
    {
        DeleteSelfLater(movedSelf);
        movedSelf = null;
    }
}
