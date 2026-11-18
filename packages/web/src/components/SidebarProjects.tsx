import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { SidebarChange } from '@ai-harness/core';
import { isPlainLinkActivation, projectLinkTo } from './session-links.js';
import { organisationMessages } from './sidebar-organisation.js';

export default function SidebarProjects({ projects, locale, disabled, onChange, onRequestClose }: {
  projects: Array<{ cwd: string; name: string }>; locale: string; disabled: boolean; onChange(change: SidebarChange): void; onRequestClose?(): void;
}) {
  const copy = organisationMessages(locale);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState('');
  return <details className="sidebar-projects"><summary>{copy.projects}</summary><ul>
    {projects.map((project, index) => <li key={project.cwd}>
      <Link to={projectLinkTo(project.cwd)} title={project.cwd} onClick={event => { if (isPlainLinkActivation(event)) onRequestClose?.(); }}>{project.name}</Link>
      <div>
        <button disabled={disabled || index === 0} aria-label={`${copy.up}: ${project.name}`}
          onClick={() => onChange({ kind: 'move-project', cwd: project.cwd, before: projects[index - 1]!.cwd })}>↑</button>
        <button disabled={disabled || index === projects.length - 1} aria-label={`${copy.down}: ${project.name}`}
          onClick={() => onChange({ kind: 'move-project', cwd: projects[index + 1]!.cwd, before: project.cwd })}>↓</button>
        <button disabled={disabled} aria-label={`${copy.name}: ${project.name}`} onClick={() => { setEditing(project.cwd); setName(project.name); }}>✎</button>
      </div>
      {editing === project.cwd && <form onSubmit={event => {
        event.preventDefault(); onChange({ kind: 'project', cwd: project.cwd, name }); setEditing(undefined);
      }}>
        <input aria-label={copy.name} maxLength={120} value={name} onChange={event => setName(event.target.value)} />
        <button disabled={disabled || !name.trim()}>{copy.save}</button>
        <button type="button" disabled={disabled} onClick={() => { onChange({ kind: 'project', cwd: project.cwd, name: null }); setEditing(undefined); }}>{copy.reset}</button>
      </form>}
    </li>)}
  </ul></details>;
}
