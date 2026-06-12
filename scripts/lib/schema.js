// Gemini 出力の JSON スキーマ検証（Ajv）+ ラベル整合性チェック。
import Ajv from 'ajv';
import { normalizeLabelChar, isValidLabel, labelIdOf, QA_LABEL_ID } from './labels.js';

const ajv = new Ajv({ allErrors: true });

/** Gemini が返すべき JSON のスキーマ。 */
export const GEMINI_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['label', 'label_id', 'confidence', 'rationale', 'is_uncertain'],
  additionalProperties: true,
  properties: {
    label: { type: 'string' },
    label_id: { type: 'integer', minimum: 0, maximum: QA_LABEL_ID },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    is_uncertain: { type: 'boolean' },
  },
};

const validateShape = ajv.compile(GEMINI_OUTPUT_SCHEMA);

/**
 * Gemini 出力を検証する。スキーマ + ラベルが許可集合内 + label_id 整合性。
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validateGeminiOutput(obj, { allowQA = true } = {}) {
  const errors = [];
  if (obj == null || typeof obj !== 'object') {
    return { valid: false, errors: ['not_an_object'] };
  }

  const shapeOk = validateShape(obj);
  if (!shapeOk) {
    for (const e of validateShape.errors || []) {
      errors.push(`${e.instancePath || '/'} ${e.message}`);
    }
  }

  // ラベルが許可集合内か。
  const label = normalizeLabelChar(obj.label);
  if (!isValidLabel(label, { allowQA })) {
    errors.push(`label_not_allowed: ${JSON.stringify(obj.label)}`);
  } else {
    // label_id とラベルの整合性。
    const expectedId = labelIdOf(label);
    if (typeof obj.label_id === 'number' && obj.label_id !== expectedId) {
      errors.push(`label_id_mismatch: got ${obj.label_id}, expected ${expectedId} for ${label}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
