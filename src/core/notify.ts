import { execFileSync } from "node:child_process";
import { windowsPowerShell } from "./scheduler.js";

/**
 * Desktop notifications from the unattended job. Never throws: a machine that
 * cannot show a notification must still sync.
 */

function xmlText(text: string): string {
  return (
    String(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: XML rejects control characters, so they are stripped
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

/**
 * The PowerShell script that shows a Windows toast. Windows PowerShell 5.1 is
 * used because it projects the WinRT types implicitly; the script travels as
 * base64 UTF-16LE so non-ASCII text never crosses an ANSI code page.
 */
export function windowsToastScript(title: string, body: string): string {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlText(title)}</text><text>${xmlText(body)}</text></binding></visual></toast>`;
  // Windows PowerShell's own AppUserModelID is always registered; an
  // unregistered id makes Windows drop the toast silently.
  const appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
  return [
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]",
    "$d = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$d.LoadXml('${xml.replace(/'/g, "''")}')`,
    "$t = New-Object Windows.UI.Notifications.ToastNotification $d",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($t)`,
  ].join("\n");
}

export function appleScriptNotification(title: string, body: string): string {
  const flat = (s: string) => String(s).replace(/[\n\r\u2028\u2029]+/g, " · ");
  const quote = (s: string) => `"${flat(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `display notification ${quote(body)} with title ${quote(title)}`;
}

export function notify(title: string, body: string, platform = process.platform): boolean {
  try {
    if (platform === "win32") {
      const encoded = Buffer.from(windowsToastScript(title, body), "utf16le").toString("base64");
      execFileSync(
        windowsPowerShell(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        {
          stdio: "ignore",
          windowsHide: true,
          timeout: 20_000,
        },
      );
      return true;
    }
    if (platform === "darwin") {
      execFileSync("/usr/bin/osascript", ["-e", appleScriptNotification(title, body)], {
        stdio: "ignore",
        timeout: 20_000,
      });
      return true;
    }
    execFileSync("notify-send", ["--app-name=opencode-sync", title, body], {
      stdio: "ignore",
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}
