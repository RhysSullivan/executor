import { createComponent } from "../create-component";

export interface FileProps {
	url: string;
	spoiler?: boolean;
}

export const File = createComponent<FileProps>({
	output: (props) => ({
		type: "component",
		data: {
			type: "file",
			url: props.url,
			spoiler: props.spoiler,
		},
	}),
});
