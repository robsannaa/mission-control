export type SkillCatalogSource =
  | "clawhub"
  | "skills-sh"
  | "git"
  | "local"
  | "bundled"
  | "plugin";

export type SkillTrustSignal = {
  provider: string;
  status: "pass" | "warn" | "fail" | "unknown";
  message?: string;
};

export type SkillCatalogItem = {
  id: string;
  slug: string;
  displayName: string;
  summary: string;
  source: SkillCatalogSource;
  installKind: "clawhub" | "skills-sh" | "git" | "none";
  installReference: string | null;
  canonicalUrl?: string;
  sourceUrl?: string;
  owner?: string;
  publisher?: string;
  version?: string;
  score?: number;
  downloads?: number;
  installsCurrent?: number;
  stars?: number;
  updatedAt?: number;
  official?: boolean;
  featured?: boolean;
  trust: {
    status: "trusted" | "unscanned" | "warning" | "blocked";
    installability: "installable" | "blocked" | "unknown";
    sourceFreshness?: string;
    verdict?: string | null;
    signals: SkillTrustSignal[];
  };
};

export type InstalledSkillCatalogItem = {
  id: string;
  slug: string;
  name: string;
  version: string;
  source: SkillCatalogSource;
  enabled: boolean;
  bundled: boolean;
  skillKey: string;
  filePath?: string;
};

export type SkillCatalogCapabilities = {
  openClawVersion: string | null;
  catalogBrowse: boolean;
  catalogSearch: boolean;
  clawHubInstall: boolean;
  skillsShInstall: boolean;
  gitInstall: boolean;
  archiveInstall: boolean;
  safeLocalExecution: boolean;
  updateInUi: boolean;
  reasons: Partial<Record<"skills-sh" | "git" | "archive", string>>;
};

