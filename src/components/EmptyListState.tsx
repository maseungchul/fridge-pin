/**
 * @file
 * 빈 목록 안내 문구와 냉장고 캐릭터를 표시한다.
 */
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { spacing, createThemedStyles } from '@/theme/tokens';
import { useAppTheme } from '@/theme/ThemeProvider';
import type { StorageMode } from '@/features/fridge/model/fridgeLayout';

interface EmptyListStateProps {
  message: string;
  description: string;
  storageMode?: StorageMode | null;
}

export function EmptyListState({ message, description, storageMode }: EmptyListStateProps) {
  const { mode, colors, fridgeDoorColors } = useAppTheme();
  const styles = getStyles(mode);
  return (
    <View style={styles.container}>
      <View style={styles.conceptContainer}>
        <Image source={storageMode === 'FROZEN' ? require('../../assets/fridge-frozen-concept.svg') : storageMode === 'CHILLED' ? require('../../assets/fridge-chilled-concept.svg') : require('../../assets/fridge-normal-concept.svg')}
          style={styles.conceptImage} contentFit="contain" svgVariables={storageMode ? { '--line': storageMode === 'FROZEN' ? colors.frozen : colors.chilled, '--fill': fridgeDoorColors[storageMode].background } : { '--line': '#706B65', '--fill': '#EEEAE5' }}
          accessible={false} pointerEvents="none" />
      </View>
      <View style={styles.messageContainer}>
        <Text style={styles.message}>{message}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
    </View>
  );
}

const getStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  container: { alignItems: 'center', padding: spacing.lg, gap: 0 },
  conceptContainer: { width: 150, height: 126, alignItems: 'center', justifyContent: 'center' },
  conceptImage: { width: 150, height: 150 },
  message: { color: colors.text, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  messageContainer: { alignSelf: 'stretch' },
  description: { position: 'absolute', top: '100%', left: 0, right: 0, marginTop: spacing.sm, color: colors.textMuted, fontSize: 14, textAlign: 'center' },
}));
