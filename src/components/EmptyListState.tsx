/**
 * @file
 * 빈 목록 안내 문구와 냉장고 캐릭터를 표시한다.
 */
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { spacing, createThemedStyles } from '@/theme/tokens';
import { useAppTheme } from '@/theme/ThemeProvider';
import type { StorageMode } from '@/features/fridge/model/fridgeLayout';

const CHARACTER_SCALE = 0.9;

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
      <View style={[styles.characterContainer, storageMode && styles.conceptContainer]}>
        {storageMode ? (
          <Image source={storageMode === 'FROZEN' ? require('../../assets/fridge-frozen-concept.svg') : require('../../assets/fridge-chilled-concept.svg')}
            style={styles.conceptImage} contentFit="contain" svgVariables={{ '--line': storageMode === 'FROZEN' ? colors.frozen : colors.chilled, '--fill': fridgeDoorColors[storageMode].background }}
            accessible={false} pointerEvents="none" />
        ) : (
          <View style={styles.character} pointerEvents="none">
            <View style={styles.fridge}>
              <View style={styles.divider} />
              <View style={[styles.handle, styles.upperHandle]} />
              <View style={[styles.handle, styles.lowerHandle]} />
              <View style={styles.eyes}><View style={styles.eye} /><View style={styles.eye} /></View>
            </View>
          </View>
        )}
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
  characterContainer: { width: 63, height: 91, alignItems: 'center', justifyContent: 'center' },
  conceptContainer: { width: 150, height: 126 },
  conceptImage: { width: 150, height: 150 },
  character: { width: 70, height: 101, transform: [{ scale: CHARACTER_SCALE }] },
  fridge: { position: 'absolute', top: 0, width: 70, height: 94, borderWidth: 1.7, borderColor: colors.chilled, borderRadius: 15, backgroundColor: colors.chilledBackground, overflow: 'hidden' },
  divider: { position: 'absolute', top: 43, left: 0, right: 0, height: 1.7, backgroundColor: colors.chilled },
  handle: { position: 'absolute', left: 6, width: 6, height: 13, borderWidth: 1.4, borderColor: colors.chilled, borderRadius: 4 },
  upperHandle: { top: 24 },
  lowerHandle: { top: 51 },
  eyes: { position: 'absolute', top: 19, left: 19, right: 14, flexDirection: 'row', justifyContent: 'space-between' },
  eye: { width: 5.5, height: 5.5, borderRadius: 3, backgroundColor: colors.chilled },
  message: { color: colors.text, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  messageContainer: { alignSelf: 'stretch' },
  description: { position: 'absolute', top: '100%', left: 0, right: 0, marginTop: spacing.sm, color: colors.textMuted, fontSize: 14, textAlign: 'center' },
}));
