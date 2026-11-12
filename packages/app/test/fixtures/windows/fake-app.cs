// A stand-in for "BUSY Bar Emulator.exe" in the Windows tests of `busy-emulator start`: a program without a window
// that runs the stand-in emulator (fake-app.mjs beside it) on the bundled Node and ends when it ends. Explorer starts
// it with no arguments and its own environment, so everything it needs lies beside it.
using System.Diagnostics;
using System.IO;

static class FakeApp
{
    static int Main()
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string folder = Path.GetDirectoryName(self);
        string resources = Path.Combine(folder, "resources");
        File.WriteAllText(Path.Combine(folder, "fake-app.pid"), Process.GetCurrentProcess().Id.ToString());
        ProcessStartInfo start = new ProcessStartInfo(Path.Combine(resources, "node", "node.exe"), "\"" + Path.Combine(folder, "fake-app.mjs") + "\"");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        using (Process child = Process.Start(start))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
