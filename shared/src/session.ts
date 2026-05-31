export type SessionStatus =
  | 'composing' | 'awaiting_spec_approval' | 'building'
  | 'awaiting_critic_resolution' | 'awaiting_push_confirm'
  | 'done' | 'failed' | 'cancelled'

export interface SpecArtifact { title: string; body: string }
export interface CodeArtifact { files: { filePath: string; content: string }[] }

export interface SessionState {
  id: string
  status: SessionStatus
  idea: string
  spec?: SpecArtifact
  approvedSpec?: SpecArtifact   // set only by human approve(); Gate 1 keys on this
  code?: CodeArtifact
  verified: boolean             // set only by verifiedReducer; Gate 3
  version: number               // optimistic lock
}

export function initialSession(id: string, idea: string): SessionState {
  return { id, status: 'composing', idea, verified: false, version: 0 }
}
