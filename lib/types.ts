export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    created: string;
    updated: string;
    resolutiondate?: string;
    description?: { content?: Array<{ content?: Array<{ text?: string }> }> };
    priority?: { name: string };
    labels?: string[];
    components?: Array<{ name: string }>;
    timetracking?: { timeSpent?: string };
    comment?: { comments?: Array<{ body?: { content?: Array<{ content?: Array<{ text?: string }> }> }; author?: { displayName?: string }; created?: string }> };
  };
}

export type ConfluenceTag = "Created" | "Contributed" | "Commented" | "Draft";

export interface ConfluencePage {
  id: string;
  title: string;
  status?: string;
  space?: { name: string; key: string };
  _links?: { webui?: string };
  history?: { createdDate?: string; lastUpdated?: { when?: string }; createdBy?: { accountId?: string } };
  _tags?: ConfluenceTag[];
}

export interface ConfluenceComment {
  container?: {
    id: string;
    title: string;
    space?: { name: string; key: string };
    _links?: { webui?: string };
  };
}

export interface GitHubPR {
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  merged_at?: string;
  closed_at?: string;
  html_url: string;
  repository_url: string;
  user?: { login: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  review_comments?: number;
}
