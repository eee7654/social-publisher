import DefaultModel from './Default.js';

class Verification extends DefaultModel {
  static get tableName() {
    return 'verification';
  }
}

export default Verification