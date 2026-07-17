import { errorMessage } from '../util.ts';
import Avatar from './Avatar.tsx';

/** Avatar preview + hidden-file-input upload row for the character/persona editors. */
export default function AvatarRow(props: {
  src: string | null | undefined;
  name: string;
  upload: (file: File) => Promise<unknown>;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  let input!: HTMLInputElement;
  const uploadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await props.upload(file);
      props.onDone();
    } catch (err) {
      props.onError(errorMessage(err));
    }
  };
  return (
    <div class="avatar-row">
      <Avatar src={props.src} name={props.name} />
      <button onClick={() => input.click()}>Change avatar</button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => void uploadFile(e.currentTarget.files?.[0])}
      />
    </div>
  );
}
