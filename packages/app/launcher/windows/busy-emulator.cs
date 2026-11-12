// busy-emulator.exe: the command line of BUSY Bar Emulator on Windows (ADR-0002, sections 7 and 7a).
//
// A real executable rather than a .cmd script: cmd.exe reads a script's arguments again and changes them (% above
// all), while this program hands its own command line to Node as it got it. It cuts off the first word (its own
// name, by the rules Windows uses for it) and passes the rest untouched, so & % ^ " and spaces reach the command line
// unchanged.
//
// What it runs: the two lines of busy-emulator.launch beside it (the Node, then the script), which the app writes for
// the launcher in %LOCALAPPDATA%\busy-emulator\bin. Without that file — the copy inside the app, in resources\bin —
// the Node and the script are found from its own place: ..\node\node.exe and
// ..\emulator\packages\server\cli\busy-emulator.mjs, but only when .. is the app's resources (app.asar there); a
// copy elsewhere without the file refuses. Its exit code is Node's.
//
// Built with the C# compiler of .NET Framework 4, which every Windows 10 and 11 has (tools/windows-launcher.mjs).
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

static class BusyEmulatorLauncher
{
    // DLLs that Windows looks up by name come from System32 only, never from this program's folder or the current one
    // (EMU-203 security review, S2). The first thing Main does.
    const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetDefaultDllDirectories(uint directoryFlags);

    const string LaunchFile = "busy-emulator.launch";

    const int STD_ERROR_HANDLE = -12;
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int handle);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetConsoleMode(IntPtr console, out uint mode);
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern bool WriteConsoleW(IntPtr console, string text, uint length, out uint written, IntPtr reserved);

    // This program's own messages name paths, and a path may have letters outside the console's code page (a user's
    // folder in Greek on a Russian Windows), which Console.Error turns into "?". So a console gets the text as
    // Unicode, and a pipe or a file gets UTF-8, as it does from Node for everything else this command prints.
    static void Say(string text)
    {
        string line = text + "\r\n";
        try
        {
            IntPtr handle = GetStdHandle(STD_ERROR_HANDLE);
            uint mode;
            uint written;
            if (GetConsoleMode(handle, out mode))
            {
                if (WriteConsoleW(handle, line, (uint)line.Length, out written, IntPtr.Zero)) return;
            }
            else
            {
                byte[] bytes = new UTF8Encoding(false).GetBytes(line);
                using (Stream error = Console.OpenStandardError())
                {
                    error.Write(bytes, 0, bytes.Length);
                    error.Flush();
                }
                return;
            }
        }
        catch (Exception)
        {
            // Below, as before.
        }
        Console.Error.WriteLine(text);
    }

    static readonly string[] NodeEnvironmentDenylist = {
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_EXTRA_CA_CERTS",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "NODE_USE_SYSTEM_CA",
        "NODE_USE_ENV_PROXY",
        "NODE_REPL_EXTERNAL_MODULE",
        "NODE_REPL_HISTORY",
        "NODE_ICU_DATA",
        "NODE_V8_COVERAGE",
        "NODE_DEBUG",
        "NODE_DEBUG_NATIVE",
        "NODE_PRESERVE_SYMLINKS",
        "NODE_PENDING_DEPRECATION",
        "NODE_REDIRECT_WARNINGS",
        "NODE_COMPILE_CACHE",
        "NODE_TEST_CONTEXT",
        "NODE_CHANNEL_FD",
        "NODE_CHANNEL_SERIALIZATION_MODE",
        "NODE_UNIQUE_ID",
        "NODE_SKIP_PLATFORM_CHECK",
        "OPENSSL_CONF",
        "OPENSSL_ENGINES",
        "OPENSSL_MODULES",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR"
    };

    static int Main()
    {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string folder = Path.GetDirectoryName(self);
        string node;
        string script;
        string launch = Path.Combine(folder, LaunchFile);
        if (File.Exists(launch))
        {
            string[] lines = File.ReadAllLines(launch, new UTF8Encoding(false));
            if (lines.Length < 2 || lines[0].Length == 0 || lines[1].Length == 0)
            {
                Say("busy-emulator: " + launch + " does not name the Node and the script to run. Open BUSY Bar Emulator once and it writes the file again.");
                return 1;
            }
            node = lines[0];
            script = lines[1];
        }
        else
        {
            string resources = Path.GetFullPath(Path.Combine(folder, ".."));
            // Only the copy inside the app has no launch file: its folder above is the app's resources, with the app
            // in it (app.asar, or app\ in a test's layout). A copy anywhere else without one (the launcher's place in
            // %LOCALAPPDATA%, its file gone) runs no node.exe of a folder the app does not own (EMU-202 review, S8).
            if (!File.Exists(Path.Combine(resources, "app.asar")) && !Directory.Exists(Path.Combine(resources, "app")))
            {
                Say("busy-emulator: " + launch + " is missing, so this command does not know which BUSY Bar Emulator to run. Open BUSY Bar Emulator once and it writes the file again.");
                return 1;
            }
            node = Path.Combine(resources, "node", "node.exe");
            script = Path.Combine(resources, "emulator", "packages", "server", "cli", "busy-emulator.mjs");
        }
        if (!File.Exists(node) || !File.Exists(script))
        {
            Say("busy-emulator: BUSY Bar Emulator is no longer where this command expects it (" + node + "). Open the emulator once and this command will find it again.");
            return 1;
        }

        ProcessStartInfo start = new ProcessStartInfo(node, "\"" + script + "\"" + Rest(Environment.CommandLine));
        start.UseShellExecute = false;
        // Node starts without the variables that would change how it starts (packages/server/cli/node-environment.mjs
        // holds the list; a test keeps the three entries equal).
        foreach (string name in NodeEnvironmentDenylist) start.EnvironmentVariables.Remove(name);
        start.EnvironmentVariables["BUSY_EMULATOR_CLI_PATH"] = self;
        // The Windows folder by the system's own account (GetWindowsDirectory), over whatever the caller set: the
        // command line takes Explorer and PowerShell from it, never from SystemRoot of the caller.
        start.EnvironmentVariables["BUSY_EMULATOR_WINDOWS_DIR"] = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        // Ctrl+C reaches Node as well, which decides what to do; this program waits for it either way.
        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; };
        using (Process child = Process.Start(start))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    // The command line without its first word, from the space before the second word on, exactly as it was given.
    // The first word follows its own rule on Windows: in quotes it ends at the next quote, otherwise at a space or tab.
    internal static string Rest(string commandLine)
    {
        int i = 0;
        if (commandLine.Length > 0 && commandLine[0] == '"')
        {
            int close = commandLine.IndexOf('"', 1);
            i = close < 0 ? commandLine.Length : close + 1;
        }
        while (i < commandLine.Length && commandLine[i] != ' ' && commandLine[i] != '\t') i++;
        if (i >= commandLine.Length) return "";
        return commandLine.Substring(i);
    }
}
