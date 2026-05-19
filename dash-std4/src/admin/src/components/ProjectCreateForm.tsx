import { FormEvent, useState } from 'react';
import { CLIENT_TARGET_OPTIONS, type ClientTargetValue } from '../constants/clientTargets';
import { ApiError } from '../api/client';

export interface ProjectCreateFormValues {
  name_zh: string;
  name_en: string;
  description: string;
  client_targets: ClientTargetValue[];
  is_new: boolean;
}

interface FieldErrors {
  name_zh?: string;
  name_en?: string;
  description?: string;
  client_targets?: string;
  global?: string;
}

interface ProjectCreateFormProps {
  submitting: boolean;
  onSubmit: (values: ProjectCreateFormValues) => Promise<void>;
}

function validate(values: ProjectCreateFormValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.name_zh.trim()) {
    errors.name_zh = '必填：请填写项目名称（中文）';
  }
  if (!values.name_en.trim()) {
    errors.name_en = '必填：请填写项目名称（英文）';
  }
  if (!values.description.trim()) {
    errors.description = '必填：请填写项目简介';
  }
  if (values.client_targets.length === 0) {
    errors.client_targets = '请至少选择一个客户端目标';
  }
  return errors;
}

export function ProjectCreateForm({ submitting, onSubmit }: ProjectCreateFormProps) {
  const [nameZh, setNameZh] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [description, setDescription] = useState('');
  const [clientTargets, setClientTargets] = useState<ClientTargetValue[]>(['admin']);
  const [isNew, setIsNew] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function toggleTarget(value: ClientTargetValue) {
    setClientTargets((prev) =>
      prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value],
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const values: ProjectCreateFormValues = {
      name_zh: nameZh.trim(),
      name_en: nameEn.trim(),
      description: description.trim(),
      client_targets: clientTargets,
      is_new: isNew,
    };

    const errors = validate(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    try {
      await onSubmit(values);
    } catch (err) {
      if (err instanceof ApiError) {
        const apiErr = err as ApiError & { errors?: string[] };
        if (apiErr.errors?.length) {
          const global = apiErr.errors.join('；');
          const clientMsg = apiErr.errors.find((m) => m.includes('client_targets'));
          setFieldErrors({
            global: global,
            client_targets: clientMsg
              ? '客户端目标校验失败，请至少选择 admin 或 backend 之一'
              : undefined,
          });
          return;
        }
        setFieldErrors({ global: err.message || '创建失败，请稍后重试' });
      } else {
        setFieldErrors({ global: '创建失败，请稍后重试' });
      }
    }
  }

  return (
    <form className="project-create-form" onSubmit={handleSubmit} noValidate>
      <label htmlFor="name_zh">项目名称（中文）</label>
      <input
        id="name_zh"
        name="name_zh"
        type="text"
        value={nameZh}
        onChange={(e) => setNameZh(e.target.value)}
        aria-label="项目名称（中文）输入框"
        aria-invalid={!!fieldErrors.name_zh}
      />
      {fieldErrors.name_zh && (
        <p className="field-error" role="alert">
          {fieldErrors.name_zh}
        </p>
      )}

      <label htmlFor="name_en">项目名称（英文）</label>
      <input
        id="name_en"
        name="name_en"
        type="text"
        value={nameEn}
        onChange={(e) => setNameEn(e.target.value)}
        aria-label="项目名称（英文）输入框"
        aria-invalid={!!fieldErrors.name_en}
      />
      {fieldErrors.name_en && (
        <p className="field-error" role="alert">
          {fieldErrors.name_en}
        </p>
      )}

      <label htmlFor="description">项目简介</label>
      <textarea
        id="description"
        name="description"
        rows={4}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        aria-label="项目简介输入框"
        aria-invalid={!!fieldErrors.description}
      />
      {fieldErrors.description && (
        <p className="field-error" role="alert">
          {fieldErrors.description}
        </p>
      )}

      <fieldset className="project-create-form__targets">
        <legend>客户端目标</legend>
        <div className="project-create-form__checkboxes" aria-label="客户端目标多选">
          {CLIENT_TARGET_OPTIONS.map((opt) => (
            <label key={opt.value}>
              <input
                type="checkbox"
                checked={clientTargets.includes(opt.value)}
                onChange={() => toggleTarget(opt.value)}
                aria-label={`客户端目标多选中的 ${opt.value} 选项`}
              />
              {opt.label}
            </label>
          ))}
        </div>
      </fieldset>
      {fieldErrors.client_targets && (
        <p className="field-error" role="alert">
          {fieldErrors.client_targets}
        </p>
      )}

      <label className="project-create-form__is-new">
        <input
          type="checkbox"
          checked={isNew}
          onChange={(e) => setIsNew(e.target.checked)}
          aria-label="标识新增的勾选框"
        />
        新增项目（is_new）
      </label>

      {fieldErrors.global && (
        <p className="form-error" role="alert">
          {fieldErrors.global}
        </p>
      )}

      <button type="submit" disabled={submitting} aria-label="提交或创建项目按钮">
        {submitting ? '创建中…' : '创建项目'}
      </button>
    </form>
  );
}
