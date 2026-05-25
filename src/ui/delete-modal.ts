import { Modal, App } from 'obsidian';

export class DeleteConfirmationModal extends Modal {
  private fileName: string;
  private onChoice: (choice: 'delete' | 'skip', applyToAll: boolean) => void;

  constructor(app: App, fileName: string, onChoice: (choice: 'delete' | 'skip', applyToAll: boolean) => void) {
    super(app);
    this.fileName = fileName;
    this.onChoice = onChoice;
  }

  onOpen() {
    const { contentEl } = this;
    
    contentEl.createEl('h2', { text: 'Confirm Deletion on Google Drive' });
    contentEl.createEl('p', {
      text: `The file "${this.fileName}" was deleted locally. Do you want to delete it from Google Drive as well?`
    });

    const applyToAllCheckboxContainer = contentEl.createDiv();
    applyToAllCheckboxContainer.style.marginTop = '15px';
    applyToAllCheckboxContainer.style.marginBottom = '15px';
    
    const checkbox = applyToAllCheckboxContainer.createEl('input', { type: 'checkbox' });
    checkbox.id = 'apply-to-all';
    
    const label = applyToAllCheckboxContainer.createEl('label', { text: ' Apply choice to all deleted files in this sync' });
    label.htmlFor = 'apply-to-all';

    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.display = 'flex';
    buttonContainer.style.justifyContent = 'flex-end';
    buttonContainer.style.gap = '10px';
    buttonContainer.style.marginTop = '20px';

    const skipBtn = buttonContainer.createEl('button', {
      text: 'Skip (Keep on Drive)'
    });
    skipBtn.addEventListener('click', () => {
      const applyToAll = checkbox.checked;
      this.close();
      this.onChoice('skip', applyToAll);
    });

    const deleteBtn = buttonContainer.createEl('button', {
      text: 'Delete from Drive',
      cls: 'mod-warning'
    });
    deleteBtn.addEventListener('click', () => {
      const applyToAll = checkbox.checked;
      this.close();
      this.onChoice('delete', applyToAll);
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
