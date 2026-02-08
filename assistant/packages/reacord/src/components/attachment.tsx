import { createComponent } from "../create-component";

export interface AttachmentProps {
	name: string;
	data: Buffer | string;
	spoiler?: boolean;
}

export const Attachment = createComponent<AttachmentProps>({
	output: (props) => ({
		type: "attachment",
		data: {
			name: props.name,
			data: props.data,
			spoiler: props.spoiler,
		},
	}),
});
