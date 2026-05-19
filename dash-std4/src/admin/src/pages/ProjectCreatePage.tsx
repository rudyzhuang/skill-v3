import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createProject } from '../api/projects';
import {
  ProjectCreateForm,
  type ProjectCreateFormValues,
} from '../components/ProjectCreateForm';

export function ProjectCreatePage() {
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(values: ProjectCreateFormValues) {
    setSubmitting(true);
    try {
      await createProject({
        name_zh: values.name_zh,
        name_en: values.name_en,
        description: values.description,
        client_targets: values.client_targets,
        is_new: values.is_new,
      });
      navigate('/projects', { replace: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="project-create-page">
      <header className="project-create-page__header">
        <h1>新建项目</h1>
      </header>
      <ProjectCreateForm submitting={submitting} onSubmit={handleSubmit} />
    </main>
  );
}
