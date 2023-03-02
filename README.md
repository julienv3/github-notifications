# GitHub Notifications extension for Visual Studio Code

Keep an eye on your GitHub notifications without leaving your editor!

![GitHub Notifications extension screenshot](resources/screenshot.png?raw=true)

## Features

This extensions allows you to see GitHub notifications (https://github.com/notifications) right in VS Code.

## Requirements

You must supply a GitHub personal access token (classic), obtainable at https://github.com/settings/tokens.

The token will need the "notifications" scope to list notifications.

Additionally, the "repo" scope can optionally be added so pull requests referred to in notifications can be indicated as merged when they are.

You can update said token through the `>GitHub Notifications: Update token` command in VS Code.

**Too many notifications?** Tweak settings to see less of them based on a cap or time range!

## Release Notes

### 0.0.9

Add "notificationsSince" and "notificationCap" settings.

### 0.0.8

Only fetch new notifications using "since" query parameter.

### 0.0.7

Fetch all notification pages.

### 0.0.6

Added approval_request & WorkflowRun icon support.

### 0.0.5

Added graceful handling of transient network issues.

### 0.0.4

Fixed README.md with extension screenshot.

### 0.0.3

Added extension-stored "done" status tracking.

### 0.0.2

Added NEW and READ panels, supporting both read and unread notifications.

### 0.0.1

Initial release!

---
