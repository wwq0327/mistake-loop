// 识别收件箱：P2 骨架。左原图右草稿的核对交互在 #18/#19 接入。
import { el, card, empty, alert, link } from '../ui.js';

export async function mount({ root, state }) {
  const notice = state.aiEnabled
    ? alert('AI 识别已开启。上传照片后，识别结果只会写进草稿，逐题确认才会成为错题。', 'info')
    : alert('AI 识别当前关闭，照片不会离开这台设备。仍可纯手工录入，功能等价；开启入口在设置页。', 'warn');

  const upload = card('收一张照片');
  const picker = el('div', 'field');
  const label = el('label', '', '选择题目照片');
  label.htmlFor = 'photo-input';
  const input = el('input', 'input');
  input.id = 'photo-input';
  input.type = 'file';
  input.accept = 'image/*';
  input.setAttribute('capture', 'environment');
  input.disabled = true;
  picker.append(label, input, el('p', 'field__hint', '拍照上传与识别任务将在 P3 接入；此处先保留入口位置。'));
  upload.body.append(picker);

  const drafts = card('待确认草稿');
  drafts.body.append(empty('还没有识别草稿', '开启 AI 并上传照片后，这里会逐题列出识别结果供核对。'));
  drafts.body.append(link('改用纯手工录入 →', '/library', 'small'));

  root.replaceChildren(notice, upload, drafts);
}
