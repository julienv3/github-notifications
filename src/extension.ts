// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import fetch from "node-fetch";
import * as path from "path";
import * as vscode from "vscode";

/* eslint-disable @typescript-eslint/naming-convention */

type Status = "unread" | "read";

interface Notification {
  reason: string;
  unread: boolean;
  subject?: {
    title?: string;
    url?: string;
    type?: string;
  };
}

const SECRET_TOKEN_KEY = "token";

export async function activate(context: vscode.ExtensionContext) {
  const updateToken = async () => {
    const newToken = await vscode.window.showInputBox({
      prompt: "Please enter GitHub notification token",
    });
    if (newToken) {
      await context.secrets.store(SECRET_TOKEN_KEY, newToken);
      vscode.window.showInformationMessage("GitHub notification token set!");
    } else {
      vscode.window.showErrorMessage(
        'GitHub notification token needed for GitHub Notifications extension to work; update it with the "Update token" command.'
      );
    }
    return newToken;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "github-notifications.updateToken",
      updateToken
    )
  );

  if (!(await context.secrets.get(SECRET_TOKEN_KEY))) {
    await updateToken();
  }

  const providers = (["unread", "read"] as Status[]).map((status) => {
    const treeDataProvider = new NotificationProvider(status);
    const treeView = vscode.window.createTreeView(
      `github-notifications-${status}`,
      {
        treeDataProvider,
        showCollapseAll: true,
      }
    );
    status === "unread" && treeDataProvider.setTreeView(treeView);
    return treeDataProvider;
  });

  new Fetcher(context.secrets, providers);
}

// This method is called when your extension is deactivated
export function deactivate() {}

function unSnakeCase(text: string) {
  const segments = text.split("_");
  const firstWord = segments.splice(0, 1)[0];
  return [firstWord[0].toUpperCase() + firstWord.slice(1)]
    .concat(segments)
    .join(" ");
}

export class Fetcher {
  constructor(
    secrets: vscode.SecretStorage,
    providers: NotificationProvider[]
  ) {
    const update = async () => {
      const bailUntilTokenFixed = () => {
        secrets.onDidChange((e) => e.key === SECRET_TOKEN_KEY && update());
      };
      const token = await secrets.get(SECRET_TOKEN_KEY);
      if (!token) {
        return bailUntilTokenFixed();
      }

      const response = await fetch(
        "https://api.github.com/notifications?all=true",
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-Github-Api-Version": "2022-11-28",
          },
        }
      );
      let notifications = (await response.json()) as Notification[];

      if (response.status === 401) {
        vscode.window.showErrorMessage(
          'Error fetching notifications; is the token valid and does it have notifications permissions? Update it with the "Update token" command.'
        );
        return bailUntilTokenFixed();
      }

      const map = notifications.reduce((acc, n) => {
        const status = n.unread ? "unread" : "read";
        const map =
          acc.get(status) ||
          (acc
            .set(status, new Map<string, Notification[]>())
            .get(status) as Map<string, Notification[]>);
        const notifs =
          map.get(n.reason) ||
          (map.set(n.reason, []).get(n.reason) as Notification[]);
        notifs.push(n);
        return acc;
      }, new Map<Status, Map<string, Notification[]>>());

      providers.forEach((p) => p.refresh(map));

      const pollInterval = response.headers.get("X-Poll-Interval");
      setTimeout(update, (pollInterval ? +pollInterval : 60) * 1000);
    };
    update();
  }
}

export class NotificationProvider
  implements vscode.TreeDataProvider<NotificationItem>
{
  private treeView?: vscode.TreeView<NotificationItem>;
  private notificationsPerReason: Map<string, Notification[]> = new Map();

  constructor(private status: Status) {}

  setTreeView(treeView: vscode.TreeView<NotificationItem>) {
    this.treeView = treeView;
  }

  getTreeItem(element: NotificationItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: NotificationItem): Thenable<NotificationItem[]> {
    if (!element) {
      const rootItems = Array.from(
        this.notificationsPerReason?.keys() || []
      ).sort((a, b) => a.localeCompare(b));
      return Promise.resolve(
        rootItems.map(
          (i) =>
            new NotificationItem(
              unSnakeCase(i) +
                ` (${this.notificationsPerReason?.get(i)?.length})`,
              i,
              "bang.svg"
            )
        )
      );
    } else if (element.root) {
      return Promise.resolve(
        this.notificationsPerReason
          ?.get(element.root)
          ?.map(
            (i) =>
              new NotificationItem(
                i.subject?.type + " : " + i.subject?.title || "(?)",
                undefined,
                i.subject?.type || "",
                i.subject?.url
                  ?.replace(
                    "https://api.github.com/repos",
                    "https://github.com"
                  )
                  .replace(/\/pulls\/(\d+)$/, "/pull/$1")
              )
          ) || []
      );
    } else {
      return Promise.resolve([]);
    }
  }

  private _onDidChangeTreeData: vscode.EventEmitter<
    NotificationItem | undefined | null | void
  > = new vscode.EventEmitter<NotificationItem | undefined | null | void>();

  public refresh(map: Map<Status, Map<string, Notification[]>>): void {
    this.notificationsPerReason = map.get(this.status) as Map<
      string,
      Notification[]
    >;

    const reviewRequiredCount = Array.from(
      this.notificationsPerReason.entries()
    ).reduce(
      (acc, [reason, notifications]) =>
        acc + (reason === "ci_activity" ? 0 : notifications.length),
      0
    );

    this.treeView &&
      (this.treeView.badge = {
        tooltip: `${reviewRequiredCount} notifications`,
        value: reviewRequiredCount,
      });

    this._onDidChangeTreeData.fire();
  }

  readonly onDidChangeTreeData: vscode.Event<
    NotificationItem | undefined | null | void
  > = this._onDidChangeTreeData.event;
}

class NotificationItem extends vscode.TreeItem {
  private ICON_DIRECTORY = {
    default: "info.svg",
    // assign: "githubnotifications.svg",
    // author: "githubnotifications.svg",
    // comment: "githubnotifications.svg",
    // ci_activity: "githubnotifications.svg",
    // invitation: "githubnotifications.svg",
    // manual: "githubnotifications.svg",
    // mention: "githubnotifications.svg",
    review_requested: "bang.svg",
    security_alert: "bang.svg",
    // state_change: "githubnotifications.svg",
    // subscribed: "githubnotifications.svg",
    // team_mention: "githubnotifications.svg",
    PullRequest: "pr.svg",
  } as Record<string, string>;

  constructor(
    public readonly label: string,
    public root: string | undefined,
    leaf?: string,
    url?: string
  ) {
    super(
      label,
      root
        ? root === "ci_activity"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.tooltip = this.label;
    (url || !root) &&
      (this.command = {
        title: "Open url",
        command: "vscode.open",
        arguments: [url || "https://github.com/notifications"],
      });
    const icon =
      (root && this.ICON_DIRECTORY[root]) ||
      (leaf && this.ICON_DIRECTORY[leaf]) ||
      this.ICON_DIRECTORY.default;
    icon &&
      (this.iconPath = {
        light: path.join(__filename, "..", "..", "resources", icon),
        dark: path.join(__filename, "..", "..", "resources", icon),
      });
  }
}
