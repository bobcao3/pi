export interface VcsSource {
	getStatus(): string | null;
	setCwd(cwd: string): void;
	onChange(callback: () => void): () => void;
	dispose(): void;
}

export type VcsSourceFactory = (cwd: string, git: { getStatus(): string | null; refresh(): void }) => VcsSource;
