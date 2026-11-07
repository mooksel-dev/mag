import type { AgentSession, Attachment, ChatRef } from '@mag/core'
import type { MagApi } from '../../preload/api'

/** What starting a subtopic calls of mag. */
export type SubtopicApi = Pick<MagApi, 'startChild' | 'renameChat' | 'send' | 'deleteChat'>

/**
 * The first message of a New subtopic draft (topic-screen-one-new-compact.2): only now the subtopic exists, a general
 * session under `parentId` with this message as its first. The draft itself is the screen's state: left without a
 * message, nothing was made. With files or referenced chats the subtopic starts empty, takes the message's first line
 * as its title, and the message goes with them (startChild sends text only); if that fails, the empty subtopic is
 * deleted, so a draft never leaves one behind.
 */
export async function startSubtopic(api: SubtopicApi, parentId: string, text: string, attachments: Attachment[], refs: ChatRef[]): Promise<AgentSession> {
  if (!attachments.length && !refs.length) return api.startChild(parentId, text, null, false)
  const child = await api.startChild(parentId, '', null, false)
  try {
    const title = text.split('\n').find((l) => l.trim())?.trim().slice(0, 60) || attachments[0]?.name
    if (title) await api.renameChat(child.id, title)
    await api.send(child.id, text, attachments, refs)
  } catch (e) {
    await api.deleteChat(child.id).catch(() => {})
    throw e
  }
  return child
}
