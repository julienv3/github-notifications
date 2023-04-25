import fetch from "node-fetch";
import * as path from "path";
import * as vscode from "vscode";

type Status = "unread" | "read";

interface Notification {
  id: string;
  reason: string;
  unread: boolean;
  subject?: {
    title?: string;
    url?: string;
    type?: string;
  };
  merged?: boolean;
}

interface RefreshHandler {
  refresh: (latest: Notification[]) => void;
}

const enum STORAGE_KEY {
  TOKEN = "token",
  DONE = "done",
}

/**
 * GitHut Notifications extension activation
 * @param context Extension context
 */
export async function activate(context: vscode.ExtensionContext) {
  // Set update token command
  const updateToken = async () => {
    const newToken = await vscode.window.showInputBox({
      prompt: "Please enter GitHub notification token",
    });
    if (newToken) {
      await context.secrets.store(STORAGE_KEY.TOKEN, newToken);
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
      "github-code-notifications.updateToken",
      updateToken
    )
  );

  // Ask for token if not set
  if (!(await context.secrets.get(STORAGE_KEY.TOKEN))) {
    await updateToken();
  }

  const storage = new GlobalStateStorage(context);
  const refreshHandlers: RefreshHandler[] = [];
  const mergedPullRequests = new Set<string>();

  // Set new and read panels
  for (const status of ["unread", "read"] as Status[]) {
    const treeDataProvider = new NotificationProvider(
      (notifications: Notification[]) => {
        const done = storage.get(STORAGE_KEY.DONE);
        return notifications.filter(
          ({ id, unread }) => !done.has(id) && unread === (status === "unread")
        );
      },
      mergedPullRequests
    );
    vscode.window.createTreeView(`github-code-notifications-${status}`, {
      treeDataProvider,
      showCollapseAll: true,
    });
    refreshHandlers.push(treeDataProvider);
  }

  // Set done panel
  const doneTreeDataProvider = new NotificationProvider(
    (notifications: Notification[]) => {
      const done = storage.get(STORAGE_KEY.DONE);
      return notifications.filter((n) => done.has(n.id));
    },
    mergedPullRequests
  );
  const treeView = vscode.window.createTreeView(
    `github-code-notifications-done`,
    {
      treeDataProvider: doneTreeDataProvider,
      showCollapseAll: true,
    }
  );
  refreshHandlers.push(doneTreeDataProvider);

  // Set badge count refresh
  refreshHandlers.push({
    refresh: (latest) => {
      const done = storage.get(STORAGE_KEY.DONE);
      const skipCI = vscode.workspace
        .getConfiguration("github-code-notifications")
        .get("ignoreCiActivity") as boolean;
      const badgeCount = latest.filter(
        ({ id, unread, reason }) =>
          !done.has(id) && unread && (!skipCI || reason !== "ci_activity")
      ).length;
      treeView.badge = {
        tooltip: `${badgeCount} new notification${badgeCount > 1 ? "s" : ""}`,
        value: badgeCount,
      };
    },
  });

  // Set latest data cache
  let latest: Notification[] = [];
  refreshHandlers.push({ refresh: (update) => (latest = update) });

  // Start polling for notifications
  poll(
    context.secrets,
    refreshHandlers,
    vscode.workspace.getConfiguration("github-code-notifications"),
    mergedPullRequests
  );

  // Set done and undone commands
  const updateDoneList = async (
    { id }: Partial<Notification>,
    add: boolean
  ) => {
    if (!id) {
      id = await vscode.window.showInputBox({
        prompt: "Please enter GitHub notification id",
      });
      if (!id) {
        return vscode.window.showErrorMessage(
          "Updating done items requires a notification id."
        );
      }
    }
    if (add) {
      storage.add(STORAGE_KEY.DONE, id);
    } else {
      storage.remove(STORAGE_KEY.DONE, id);
    }
    refreshHandlers.forEach((p) => p.refresh(latest));
  };

  for (const operation of ["done", "undone"] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `github-code-notifications.${operation}`,
        (n) => updateDoneList(n, operation === "done")
      )
    );
  }
}

export function deactivate() {}

/**
 * Format snake_case identifiers as readable labels
 * @param text snake_case
 * @returns Snake case
 */
function unSnakeCase(text: string) {
  const segments = text.split("_");
  const firstWord = segments.splice(0, 1)[0];
  return [firstWord[0].toUpperCase() + firstWord.slice(1)]
    .concat(segments)
    .join(" ");
}

/**
 * Poll for notifications and update refresh handlers on data reception
 * @param secrets Extension secrets
 * @param refreshHandlers Refresh handlers to call with the latest data on data update
 * @param config Extension workspace config
 */
function poll(
  secrets: vscode.SecretStorage,
  refreshHandlers: RefreshHandler[],
  config: vscode.WorkspaceConfiguration,
  mergedPullRequests: Set<string>
) {
  const { log, logError } = (() => {
    const output = vscode.window.createOutputChannel("GitHub Notifications");
    const logger = (message: string, error?: true) => {
      output.appendLine(
        `${new Date().toLocaleString()} [${
          error ? "error" : "info"
        }] ${message}`
      );
      error && vscode.window.showErrorMessage(message);
    };
    return {
      log: (message: string) => logger(message),
      logError: (message: string) => logger(message, true),
    };
  })();

  const notifications = new Map<string, Notification>();
  const cap = config.get<number>("notificationCap") || 100;
  const per_page = 50;
  const days = config.get<number>("notificationsSince");
  const defaultSince = days
    ? new Date(Date.now() - 1000 * 60 * 60 * 24 * days).toISOString()
    : "";
  let since = defaultSince;
  // Notification going from "unread" to "read" doesn't update its timestamp;
  // until it does, "since" shouldn't be updated  as it will hide "unread" to "read" updates.
  // Still, let's be curteous to GitHub and not care about "read" if reading > 4 pages per poll;
  // "unread" to "read" updates will then be refreshed every 30 minutes.
  const beCurteous = cap / per_page > 4;
  beCurteous && setInterval(() => (since = defaultSince), 30 * 60 * 1000);
  const updateSinceToNow = beCurteous
    ? () => (since = new Date().toISOString())
    : undefined;

  let recoveryTimeout: NodeJS.Timeout;
  const scheduleRecovery = () => {
    recoveryTimeout && clearTimeout(recoveryTimeout);
    recoveryTimeout = setTimeout(update, 10 * 60000 * 1000);
  };

  const update = async () => {
    log("Updating...");
    scheduleRecovery();

    const bailUntilTokenFixed = () => {
      secrets.onDidChange((e) => e.key === STORAGE_KEY.TOKEN && update());
    };
    const token = await secrets.get(STORAGE_KEY.TOKEN);
    if (!token) {
      return bailUntilTokenFixed();
    }
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-Github-Api-Version": "2022-11-28",
    };

    // Fetch notifications
    let loadMore = true;
    let page = 1;
    let pollInterval: string | null = null;
    let fetched = 0;
    while (loadMore && (!cap || fetched < cap)) {
      const abortController = new AbortController();
      const abortTimeout = setTimeout(() => abortController.abort(), 60000);
      const response = await (() => {
        try {
          return fetch(
            `https://api.github.com/notifications?all=true&page=${page++}&per_page=${per_page}&since=${since}`,
            { headers, signal: abortController.signal as any }
          ).catch((e) => {
            logError(`Error fetching notifications: ${e}`);
          });
        } catch (e) {
          logError(`Error in notifications fetch: ${e}`);
        }
      })();
      clearTimeout(abortTimeout);

      if (!response) {
        logError("Error fetching notifications, retrying in 60 seconds.");
        setTimeout(update, 60 * 1000);
        return;
      }

      if (response.status === 401) {
        logError(
          'Error fetching notifications; is the token valid and does it have notifications permissions? Update it with the "Update token" command.'
        );
        return bailUntilTokenFixed();
      }
      let pageNotifications: Notification[] = [];
      try {
        pageNotifications = (await response.json()) as Notification[];
        for (const notification of pageNotifications) {
          notifications.set(notification.id, notification);
        }
      } catch (e) {
        logError(`Error fetching page: ${e}`);
        pageNotifications = [];
      }
      log(`Fetched ${pageNotifications.length} notifications.`);
      loadMore = pageNotifications.length === per_page;
      fetched += pageNotifications.length;

      pollInterval = response.headers.get("X-Poll-Interval");
    }
    log(`Accumulated ${notifications.size} notifications.`);

    const notificationsArray = Array.from(notifications.values());
    const refresh = () =>
      refreshHandlers.forEach((p) => p.refresh(notificationsArray));
    // Fetch pull request merge status for all pull-request-related notifications
    Promise.all(
      notificationsArray
        .filter((n) => n.subject?.type === "PullRequest" && n.subject.url)
        .map(async (n) => {
          if (!mergedPullRequests.has(n.subject!.url!)) {
            log(`Fetching pull request status at ${n.subject!.url}`);
            try {
              const pull = await fetch(n.subject!.url!, { headers }).catch(
                (e) => {
                  // Don't log as error, this is extra info so not worth annoying the user.
                  log(`Fetching a pull request failed; ${e}`);
                }
              );
              const pullJson = (await pull?.json()) as
                | { merged_at: string }
                | undefined;
              if (pullJson?.merged_at) {
                mergedPullRequests.add(n.subject!.url!);
              }
            } catch (e) {
              // Don't log as error, this is extra info so not worth annoying the user.
              log(`Error in pull request fetch: ${e}`);
            }
          }
        })
    ).then(() => {
      log("Refreshing data after PR fetch...");
      refresh();
    });

    log("Refreshing data...");
    refresh();

    const nextPoll = pollInterval && !isNaN(+pollInterval) ? +pollInterval : 60;
    log(`Scheduling next update in ${nextPoll} seconds.`);
    updateSinceToNow?.();
    setTimeout(update, nextPoll * 1000);
  };
  update();
}

/**
 * Handles extension storage gets and updates
 */
class GlobalStateStorage {
  private globalState: vscode.Memento;
  constructor(context: vscode.ExtensionContext) {
    this.globalState = context.globalState;
  }

  public get(key: string) {
    return new Set(this.globalState.get(key) as string[]);
  }

  public add(key: string, id: string) {
    const done = this.get(key);
    done.add(id);
    this.globalState.update(key, Array.from(done.values()));
  }

  public remove(key: string, id: string) {
    const done = this.get(key);
    done.delete(id);
    this.globalState.update(key, Array.from(done.values()));
  }
}

/**
 * Notification tree data provider
 */
export class NotificationProvider
  implements vscode.TreeDataProvider<NotificationItem>, RefreshHandler
{
  private notificationsPerReason: Map<string, Notification[]> = new Map();

  constructor(
    private notificationFilter: (
      notifications: Notification[]
    ) => Notification[],
    private mergedPullRequests: Set<string>
  ) {}

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
          (id) =>
            new NotificationItem(
              id,
              unSnakeCase(id) +
                ` (${this.notificationsPerReason?.get(id)?.length})`
            )
        )
      );
    } else if (!element.notification) {
      return Promise.resolve(
        this.notificationsPerReason
          ?.get(element.id)
          ?.map(
            (n) =>
              new NotificationItem(
                n.id,
                `${n.subject?.title || "(?)"}`,
                n,
                this.mergedPullRequests
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

  readonly onDidChangeTreeData: vscode.Event<
    NotificationItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  public refresh(latest: Notification[]): void {
    this.notificationsPerReason = this.notificationFilter(latest).reduce(
      (map, n) => {
        const notifications =
          map.get(n.reason) ||
          (map.set(n.reason, []).get(n.reason) as Notification[]);
        notifications.push(n);
        return map;
      },
      new Map<string, Notification[]>()
    );

    this._onDidChangeTreeData.fire();
  }
}

/**
 * Notification representation for tree views
 */
class NotificationItem extends vscode.TreeItem {
  private static ICON_DIRECTORY = {
    default: "info.svg",
    approval_requested: "deploy.svg",
    assign: "issue.svg",
    author: "edit.svg",
    comment: "comment.svg",
    ci_activity: "warn.svg",
    invitation: "invite.svg",
    manual: "subscribe.svg",
    mention: "at.svg",
    review_requested: "review.svg",
    security_alert: "bang.svg",
    state_change: "info.svg",
    subscribed: "subscribe.svg",
    team_mention: "team.svg",
    PullRequest: "pr.svg",
    PullRequestMerged: "merged.svg",
    CheckSuite: "fail.svg",
    Issue: "issue.svg",
    WorkflowRun: "workflow.svg",
  } as Record<string, string>;

  constructor(
    public id: string,
    public label: string,
    public notification?: Notification,
    mergedPullRequests?: Set<string>
  ) {
    super(
      label,
      notification
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Expanded
    );

    const leaf = notification?.subject?.type || "";
    const url = notification?.subject?.url
      ?.replace("https://api.github.com/repos", "https://github.com")
      .replace(/\/pulls\/(\d+)$/, "/pull/$1");

    this.tooltip = this.label;
    (url || notification) &&
      (this.command = {
        title: "Open url",
        command: "vscode.open",
        arguments: [url || "https://github.com/notifications"],
      });
    const icon =
      (notification
        ? NotificationItem.ICON_DIRECTORY[
            notification.subject?.type +
              (notification.subject?.url &&
              mergedPullRequests?.has(notification.subject.url)
                ? "Merged"
                : "")
          ]
        : NotificationItem.ICON_DIRECTORY[id]) ||
      NotificationItem.ICON_DIRECTORY.default;
    this.iconPath = path.join(__filename, "..", "..", "resources", icon);
    this.contextValue = notification ? "leaf" : "root";
  }
}
