// A stand-in for the three programs of an installed app that the uninstaller's tests need, told apart by the name it
// is installed under (test/unit/windows-uninstall.test.mjs):
//   resources\bin\busy-emulator.exe   the command line: writes its arguments to cli-called.txt in the app's folder
//   BUSY Bar Emulator.exe             the app: runs until cli-called.txt appears beside it (the command line's quit),
//                                     then ends with 0; after a minute it ends with 1
//   any other name (node.exe)         a command that runs for a minute; the test that started it ends it
using System.Diagnostics;
using System.IO;
using System.Threading;

static class UninstallStandIn
{
    static int Main(string[] args)
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string name = Path.GetFileName(self).ToLowerInvariant();
        string folder = Path.GetDirectoryName(self);
        if (name == "busy-emulator.exe")
        {
            string app = Path.GetDirectoryName(Path.GetDirectoryName(folder));
            File.WriteAllText(Path.Combine(app, "cli-called.txt"), string.Join(" ", args));
            return 0;
        }
        bool isApp = name == "busy bar emulator.exe";
        for (int i = 0; i < 240; i++)
        {
            if (isApp && File.Exists(Path.Combine(folder, "cli-called.txt"))) return 0;
            Thread.Sleep(250);
        }
        return 1;
    }
}
