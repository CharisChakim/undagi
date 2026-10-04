// A bug report is a prefilled "new issue" page on the project's GitHub. Undagi
// sends nothing itself: the user reads the filled form in the browser and
// submits it there under their own account. Changing where reports go is a
// change to this file and nothing else.

export const BUG_REPORT_REPOSITORY = "CharisChakim/undagi";

export const BUG_TITLE_MAX = 120;
export const BUG_DESCRIPTION_MAX = 2_000;

// GitHub refuses a "new issue" URL much past 8 KB; stay well under it.
const MAX_URL_LENGTH = 7_000;

export interface BugReport {
  title: string;
  description: string;
}

function build(report: BugReport, version: string): string {
  const body = `${report.description}\n\n---\nUndagi ${version}`;
  const query = new URLSearchParams({ title: report.title, body, labels: "bug" });
  return `https://github.com/${BUG_REPORT_REPOSITORY}/issues/new?${query.toString()}`;
}

/** Whether the report has what a maintainer needs: a title and a description. */
export function isBugReportComplete(report: BugReport): boolean {
  return report.title.trim().length > 0 && report.description.trim().length > 0;
}

export function bugReportUrl(report: BugReport, version: string): string {
  const title = report.title.trim().slice(0, BUG_TITLE_MAX);
  let description = report.description.trim().slice(0, BUG_DESCRIPTION_MAX);
  // Characters outside ASCII encode to several bytes each; cut the description,
  // never the title or the version line, until the link fits.
  let url = build({ title, description }, version);
  while (url.length > MAX_URL_LENGTH && description.length > 0) {
    description = description.slice(0, Math.floor(description.length * 0.9));
    url = build({ title, description }, version);
  }
  return url;
}
