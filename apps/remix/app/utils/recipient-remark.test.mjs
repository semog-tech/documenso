import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editRecipientRemark, findRecipientRemark } from './recipient-remark.ts';

const field = {
  id: 10,
  recipientId: 1,
  type: 'TEXT',
  customText: 'Ressalva anterior',
  fieldMeta: { type: 'text', label: 'Comentário / ressalvas (opcional)', required: false, readOnly: false },
};
const state = { recipientId: 1, signingStatus: 'NOT_SIGNED', envelopeStatus: 'PENDING' };
describe('recipient remark shortcut', () => {
  it('finds only the own optional remark and preserves an inserted value', () => {
    assert.equal(findRecipientRemark([field], state), field);
  });
  for (const patch of [
    { recipientId: 2 },
    { type: 'SIGNATURE' },
    { fieldMeta: { ...field.fieldMeta, label: 'Other' } },
    { fieldMeta: { ...field.fieldMeta, required: true } },
    { fieldMeta: { ...field.fieldMeta, required: undefined } },
    { fieldMeta: { ...field.fieldMeta, readOnly: true } },
  ]) {
    it(`rejects ineligible ${JSON.stringify(patch)}`, () => {
      assert.equal(findRecipientRemark([{ ...field, ...patch }], state), undefined);
    });
  }
  for (const patch of [
    { signingStatus: 'SIGNED' },
    { envelopeStatus: 'COMPLETED' },
    { envelopeStatus: 'CANCELLED' },
    { envelopeStatus: 'REJECTED' },
  ]) {
    it(`rejects completed or inactive ${JSON.stringify(patch)}`, () => {
      assert.equal(findRecipientRemark([field], { ...state, ...patch }), undefined);
    });
  }
  it('cancel preserves existing text without saving or clearing', async () => {
    let writes = 0;
    await editRecipientRemark({
      initialText: field.customText,
      open: (initial) => {
        assert.equal(initial, field.customText);
        return Promise.resolve(null);
      },
      save: () => {
        writes += 1;
        return Promise.resolve();
      },
      isActive: () => true,
    });
    assert.equal(writes, 0);
  });
  it('edit confirms the replacement exactly once', async () => {
    const writes = [];
    await editRecipientRemark({
      initialText: field.customText,
      open: () => Promise.resolve('Ressalva editada'),
      save: (value) => {
        writes.push(value);
        return Promise.resolve();
      },
      isActive: () => true,
    });
    assert.deepEqual(writes, ['Ressalva editada']);
  });
  it('does not save after recipient changes while dialog is open', async () => {
    let writes = 0;
    await editRecipientRemark({
      initialText: 'Anterior',
      open: () => Promise.resolve('Nova'),
      save: () => {
        writes += 1;
        return Promise.resolve();
      },
      isActive: () => false,
    });
    assert.equal(writes, 0);
  });
  it('propagates a failed save instead of reporting success', async () => {
    await assert.rejects(
      editRecipientRemark({
        initialText: 'Anterior',
        open: () => Promise.resolve('Nova'),
        save: () => {
          return Promise.reject(new Error('save failed'));
        },
        isActive: () => true,
      }),
      /save failed/,
    );
  });
});
