module.exports = {
  preset: '@react-native/jest-preset',
  // Native modules never load under Jest: the MansarConfig spec resolves to
  // its manual mock (src/specs/__mocks__), which tests adjust per case.
  setupFiles: ['<rootDir>/jest.setup.js'],
};
