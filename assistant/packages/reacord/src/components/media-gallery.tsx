import type { ReactNode } from "react";
import { ReacordElement } from "../internal/element";
import type {
	MediaGalleryComponent,
	MediaGalleryItem as MediaGalleryItemData,
	MessageOptions,
} from "../internal/message";
import { Node } from "../internal/node";

export interface MediaGalleryProps {
	children?: ReactNode;
}

export function MediaGallery(props: MediaGalleryProps) {
	return (
		<ReacordElement props={props} createNode={(p) => new MediaGalleryNode(p)}>
			{props.children}
		</ReacordElement>
	);
}

export interface MediaGalleryItemProps {
	url: string;
	description?: string;
	spoiler?: boolean;
}

export function MediaGalleryItem(props: MediaGalleryItemProps) {
	return (
		<ReacordElement
			props={props}
			createNode={(p) => new MediaGalleryItemNode(p)}
		/>
	);
}

export class MediaGalleryItemNode extends Node<MediaGalleryItemProps> {
	override get text() {
		return "";
	}

	getItemData(): MediaGalleryItemData {
		return {
			url: this.props.url,
			description: this.props.description,
			spoiler: this.props.spoiler,
		};
	}
}

class MediaGalleryNode extends Node<MediaGalleryProps> {
	override get text() {
		return "";
	}

	protected override modifyMessageOptionsInternal(
		options: MessageOptions,
	): void {
		const items: MediaGalleryItemData[] = [];

		for (const child of this.children) {
			if (child instanceof MediaGalleryItemNode) {
				items.push(child.getItemData());
			}
		}

		const gallery: MediaGalleryComponent = {
			type: "mediaGallery",
			items,
		};

		options.components.push(gallery);
	}
}
