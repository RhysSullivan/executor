import { createComponent } from "../create-component";

export interface ThumbnailProps {
	url: string;
	description?: string;
	spoiler?: boolean;
}

export const Thumbnail = createComponent<ThumbnailProps>({
	output: (props) => ({
		type: "component",
		data: {
			type: "thumbnail",
			url: props.url,
			description: props.description,
			spoiler: props.spoiler,
		},
	}),
});
