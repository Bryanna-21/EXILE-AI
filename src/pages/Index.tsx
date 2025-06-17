import { useState } from 'react';
import { MessageCircle, Camera, Search, Cookie, Mic, Files, Share2, Smartphone, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import ChatSection from '@/components/ChatSection';
import CameraSection from '@/components/CameraSection';
import FilesSection from '@/components/FilesSection';
import ShareSection from '@/components/ShareSection';
import VoiceSection from '@/components/VoiceSection';
import ImageAnalysisSection from '@/components/ImageAnalysisSection';

const Index = () => {
  const [activeSection, setActiveSection] = useState('chat');
  const [isOnline, setIsOnline] = useState(true);
  const [message, setMessage] = useState('');

  const menuItems = [
    { id: 'chat', icon: MessageCircle, label: 'Chat', color: 'bg-blue-500' },
    { id: 'camera', icon: Camera, label: 'Camera', color: 'bg-green-500' },
    { id: 'analysis', icon: Search, label: 'Image Analysis', color: 'bg-purple-500' },
    { id: 'generate', icon: Cookie, label: 'Generate Image', color: 'bg-orange-500' },
    { id: 'voice', icon: Mic, label: 'Voice', color: 'bg-red-500' },
    { id: 'files', icon: Files, label: 'Files', color: 'bg-yellow-500' },
    { id: 'share', icon: Share2, label: 'Share', color: 'bg-pink-500' },
    { id: 'location', icon: Smartphone, label: 'Location', color: 'bg-indigo-500' },
  ];

  const renderActiveSection = () => {
    switch (activeSection) {
      case 'chat':
        return <ChatSection />;
      case 'camera':
        return <CameraSection />;
      case 'analysis':
        return <ImageAnalysisSection />;
      case 'voice':
        return <VoiceSection />;
      case 'files':
        return <FilesSection />;
      case 'share':
        return <ShareSection />;
      default:
        return <ChatSection />;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-600 via-purple-600 to-blue-700">
      {/* Header */}
      <div className="text-center py-8 px-4">
        <div className="flex items-center justify-center gap-2 mb-4">
          <Smartphone className="w-8 h-8 text-white" />
          <h1 className="text-3xl font-bold text-white">Exile</h1>
        </div>
        <p className="text-white/80 text-lg">Access everything with AI power</p>
        
        {/* Online/Offline Toggle */}
        <div className="flex items-center justify-center gap-2 mt-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsOnline(!isOnline)}
            className="text-white hover:bg-white/10"
          >
            {isOnline ? (
              <>
                <Wifi className="w-4 h-4 mr-2" />
                Online
              </>
            ) : (
              <>
                <WifiOff className="w-4 h-4 mr-2" />
                Offline
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Menu Items */}
      <div className="px-4 mb-6">
        <div className="grid grid-cols-4 gap-4 max-w-2xl mx-auto">
          {menuItems.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              className={`flex flex-col items-center gap-2 p-4 h-auto text-white hover:bg-white/10 transition-all duration-200 ${
                activeSection === item.id ? 'bg-white/20 scale-105' : ''
              }`}
              onClick={() => setActiveSection(item.id)}
            >
              <div className={`p-3 rounded-full ${item.color}`}>
                <item.icon className="w-6 h-6 text-white" />
              </div>
              <span className="text-xs font-medium">{item.label}</span>
            </Button>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="px-4 pb-6">
        <Card className="max-w-2xl mx-auto bg-white/95 backdrop-blur-sm border-0 shadow-2xl">
          <CardContent className="p-0">
            {renderActiveSection()}
          </CardContent>
        </Card>
      </div>

      {/* Bottom Input Area */}
      <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/20 to-transparent">
        <div className="max-w-2xl mx-auto">
          <div className="flex gap-2">
            <Input
              placeholder="Type your message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="flex-1 bg-white/90 backdrop-blur-sm border-0 shadow-lg"
            />
            <Button 
              className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white shadow-lg"
              onClick={() => {
                console.log('Sending message:', message);
                setMessage('');
              }}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;
