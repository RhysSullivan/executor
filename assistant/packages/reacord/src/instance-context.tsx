import { createContext, useContext } from "react";
import type { ReacordInstance } from "./instance";
import { raise } from "./internal/helpers";

const InstanceContext = createContext<ReacordInstance | undefined>(undefined);

export function InstanceProvider({
	value,
	children,
}: {
	value: ReacordInstance;
	children: React.ReactNode;
}) {
	return (
		<InstanceContext.Provider value={value}>
			{children}
		</InstanceContext.Provider>
	);
}

export function useInstance(): ReacordInstance {
	const instance = useContext(InstanceContext);
	if (!instance) {
		raise("useInstance must be used within a Reacord instance");
	}
	return instance;
}
