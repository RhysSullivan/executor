import type { ReactNode } from "react";

export interface ReacordInstance {
	render(content: ReactNode): ReacordInstance;
	deactivate(): void;
	destroy(): void;
}
